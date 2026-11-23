package proxy

import (
	"net/http"
	"testing"
	"time"

	"github.com/getstratum/stratum/gateway/internal/quota"
	"github.com/getstratum/stratum/gateway/internal/snapshot"
)

// suspend applies a delta that only says the organization's state, as a
// control plane from 1.0 sends with every sync.
func suspend(t *testing.T, e *env, status string) {
	t.Helper()
	st := e.h.Holder.State()
	next, err := st.Apply(&snapshot.SyncResponse{CurrentVersion: snapshot.Int64(st.Version),
		Organization: &snapshot.WireOrganization{Status: status}}, false)
	if err != nil {
		t.Fatal(err)
	}
	e.h.Holder.Store(next, snapshot.Build(next, time.Now()))
}

func TestASuspendedOrganizationIsRefusedEverything(t *testing.T) {
	e := newEnv(t, allowAll, time.Minute)
	suspend(t, e, "suspended")

	res := e.post("/v1/chat/completions", devKey, `{"model":"openai/gpt-4o","messages":[]}`)
	if res.StatusCode != http.StatusForbidden || errCode(t, res) != "org_suspended" {
		t.Fatalf("suspended: %d", res.StatusCode)
	}
	e.up.mu.Lock()
	reached := e.up.path != ""
	e.up.mu.Unlock()
	if reached {
		t.Fatal("a suspended organization reached the provider")
	}
	// A key that is not valid is still a 401: suspension says nothing to strangers.
	if res := e.post("/v1/chat/completions", "nope", `{}`); res.StatusCode != 401 {
		t.Fatalf("bad key: %d", res.StatusCode)
	}
	// The refusal is recorded as the team's.
	if r := e.usage.wait(t, 1)[0]; r.TeamID != "t1" {
		t.Fatalf("record: %+v", r)
	}

	// Active again: it goes.
	suspend(t, e, "active")
	if res := e.post("/v1/chat/completions", devKey, `{"model":"openai/gpt-4o","messages":[]}`); res.StatusCode != 200 {
		t.Fatalf("active again: %d", res.StatusCode)
	}
}

func TestAControlPlaneThatSaysNothingLeavesTheStateAsItWas(t *testing.T) {
	e := newEnv(t, allowAll, time.Minute)
	suspend(t, e, "suspended")
	// A delta without "organization" (a control plane before 1.0, or none
	// of it in this response) keeps the last state received.
	st := e.h.Holder.State()
	next, _ := st.Apply(&snapshot.SyncResponse{CurrentVersion: snapshot.Int64(st.Version)}, false)
	if !snapshot.Build(next, time.Now()).Suspended() {
		t.Fatal("a delta without the organization's state lifted the suspension")
	}
	// A full sync without it: a control plane before 1.0, which has no suspension.
	full, _ := st.Apply(&snapshot.SyncResponse{CurrentVersion: snapshot.Int64(st.Version)}, true)
	if snapshot.Build(full, time.Now()).Suspended() {
		t.Fatal("a full sync without the organization's state kept it suspended")
	}
}

// planLimits sets the organization's plan ceilings, as a control plane from
// 1.0 sends them with every sync.
func planLimits(t *testing.T, e *env, tokens *int64, budget *float64) {
	t.Helper()
	org := &snapshot.WireOrganization{Status: "active"}
	if tokens != nil {
		v := snapshot.Int64(*tokens)
		org.MonthlyTokenQuota = &v
	}
	if budget != nil {
		v := snapshot.Float64(*budget)
		org.MonthlyBudgetUSD = &v
	}
	st := e.h.Holder.State()
	next, err := st.Apply(&snapshot.SyncResponse{CurrentVersion: snapshot.Int64(st.Version), Organization: org}, false)
	if err != nil {
		t.Fatal(err)
	}
	e.h.Holder.Store(next, snapshot.Build(next, time.Now()))
}

func TestThePlanCapsTheWholeOrganization(t *testing.T) {
	e := newEnv(t, allowAll, time.Minute)
	ask := func() *http.Response {
		return e.post("/v1/chat/completions", devKey, `{"model":"openai/gpt-4o","messages":[]}`)
	}
	// Without ceilings, nothing changes.
	if res := ask(); res.StatusCode != 200 {
		t.Fatalf("no plan: %d", res.StatusCode)
	}
	// 18 tokens used (11 + 7); a plan of 20 lets one more request through.
	limit := int64(20)
	planLimits(t, e, &limit, nil)
	if res := ask(); res.StatusCode != 200 {
		t.Fatalf("under the plan: %d", res.StatusCode)
	}
	res := ask()
	if res.StatusCode != http.StatusTooManyRequests || errCode(t, res) != "org_quota_exceeded" {
		t.Fatalf("over the plan's tokens: %d", res.StatusCode)
	}

	// The budget, from what the control plane reports for every team.
	planLimits(t, e, nil, ptr(5.0))
	e.quota.SetReported(quota.Month(time.Now()), map[string]quota.Reported{})
	if res := ask(); res.StatusCode != 200 {
		t.Fatalf("no spend reported: %d", res.StatusCode)
	}
	e.quota.SetReported(quota.FromWire(&snapshot.WireMonthUsage{Month: quota.Month(time.Now()),
		Teams: []snapshot.WireTeamUsage{{TeamID: "t1", CostUSD: 3}, {TeamID: "t2", CostUSD: 2}}}))
	res = ask()
	if res.StatusCode != http.StatusTooManyRequests || errCode(t, res) != "org_budget_exceeded" {
		t.Fatalf("over the plan's budget: %d", res.StatusCode)
	}
}

func ptr[T any](v T) *T { return &v }
