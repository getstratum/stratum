package proxy

import (
	"net/http"
	"testing"
	"time"

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
