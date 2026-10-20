package quota

import (
	"testing"
	"time"

	"github.com/getstratum/stratum/gateway/internal/snapshot"
)

func budgetPolicy(usd float64) snapshot.Policy { return snapshot.Policy{MonthlyBudgetUSD: &usd} }

// A gateway that restarted, or a replica that counts on its own, still sees
// the month's usage: the control plane's count is a floor for the quota.
func TestReportedUsageIsAFloorForTheQuota(t *testing.T) {
	now := time.Date(2026, 10, 20, 9, 0, 0, 0, time.UTC)
	for name, e := range map[string]Enforcer{
		"local":  func() *Local { l := NewLocal(); l.now = func() time.Time { return now }; return l }(),
		"shared": newTestShared(newFakeStore(), &now, false),
	} {
		t.Run(name, func(t *testing.T) {
			pol := quotaPolicy(1000)
			if v := e.Check("t1", pol); v != nil {
				t.Fatalf("fresh team: %v", v)
			}
			e.SetReported("2026-10", map[string]Reported{"t1": {Tokens: 990}})
			if v := e.Check("t1", pol); v != nil {
				t.Fatalf("990/1000 reported must pass: %v", v)
			}
			e.Add("t1", 5) // local 5 < reported 990: no double counting
			if v := e.Check("t1", pol); v != nil {
				t.Fatalf("max(5, 990) must pass: %v", v)
			}
			e.SetReported("2026-10", map[string]Reported{"t1": {Tokens: 1000}})
			if v := e.Check("t1", pol); v == nil || v.Code != "quota_exceeded" {
				t.Fatalf("1000/1000 reported must be refused, got %v", v)
			}
			if v := e.Check("t2", pol); v != nil {
				t.Fatal("other teams are unaffected")
			}
			// A report for another month (the control plane's clock, or a
			// report from before midnight) is ignored.
			e.SetReported("2026-09", map[string]Reported{"t1": {Tokens: 5000}})
			if v := e.Check("t1", pol); v != nil {
				t.Fatalf("last month's report must not count: %v", v)
			}
		})
	}
}

func TestBudgetUsesTheReportedSpend(t *testing.T) {
	now := time.Date(2026, 10, 20, 9, 0, 0, 0, time.UTC)
	for name, e := range map[string]Enforcer{
		"local":  func() *Local { l := NewLocal(); l.now = func() time.Time { return now }; return l }(),
		"shared": newTestShared(newFakeStore(), &now, true), // fail closed: budgets do not depend on Valkey
	} {
		t.Run(name, func(t *testing.T) {
			pol := budgetPolicy(50)
			if v := e.Check("t1", pol); v != nil {
				t.Fatalf("no report yet: the budget is not enforced, got %v", v)
			}
			e.SetReported("2026-10", map[string]Reported{"t1": {Tokens: 10, CostUSD: 49.99}})
			if v := e.Check("t1", pol); v != nil {
				t.Fatalf("US$ 49.99 of 50 must pass: %v", v)
			}
			e.SetReported("2026-10", map[string]Reported{"t1": {Tokens: 10, CostUSD: 50}})
			if v := e.Check("t1", pol); v == nil || v.Code != "budget_exceeded" || v.Status != 429 {
				t.Fatalf("US$ 50 of 50 must be refused with 429 budget_exceeded, got %v", v)
			}
			// A team without usage in the report has spent nothing.
			if v := e.Check("t2", pol); v != nil {
				t.Fatalf("t2 has no usage: %v", v)
			}
			// Quota and budget together: whichever runs out first.
			both := budgetPolicy(100)
			q := int64(20)
			both.MonthlyTokenQuota = &q
			e.SetReported("2026-10", map[string]Reported{"t1": {Tokens: 25, CostUSD: 1}})
			if s, ok := e.(*Shared); ok {
				mustFlush(t, s) // the store is up: fail closed does not apply
			}
			if v := e.Check("t1", both); v == nil || v.Code != "quota_exceeded" {
				t.Fatalf("tokens ran out first: %v", v)
			}
			if v := e.Check("t1", snapshot.Policy{}); v != nil {
				t.Fatal("no quota and no budget means unlimited")
			}
		})
	}
}

func TestFromWire(t *testing.T) {
	month, teams := FromWire(&snapshot.WireMonthUsage{Month: "2026-10", Teams: []snapshot.WireTeamUsage{
		{TeamID: "a", Tokens: 12, CostUSD: 0.5}, {TeamID: "", Tokens: 99},
	}})
	if month != "2026-10" || len(teams) != 1 || teams["a"].Tokens != 12 || teams["a"].CostUSD != 0.5 {
		t.Fatalf("got %s %v", month, teams)
	}
}
