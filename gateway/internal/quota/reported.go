package quota

import (
	"net/http"
	"sync/atomic"

	"github.com/getstratum/stratum/gateway/internal/policy"
	"github.com/getstratum/stratum/gateway/internal/snapshot"
)

// Reported is a team's usage this month as the control plane counted it:
// every gateway and replica of the organization, from the usage they report
// (ADR-0009), with the cost the control plane computed from its prices.
// It arrives with each sync and lags reality by about one usage interval
// plus one sync interval.
type Reported struct {
	Tokens  int64
	CostUSD float64
}

// ReportedSetter is implemented by the enforcers; the syncer calls it after
// each successful sync.
type ReportedSetter interface {
	SetReported(month string, teams map[string]Reported)
}

// FromWire converts what the control plane sends. The organization's total
// goes under OrgKey: the sum of its teams', since the report covers every
// team of the organization.
func FromWire(u *snapshot.WireMonthUsage) (string, map[string]Reported) {
	teams := make(map[string]Reported, len(u.Teams)+1)
	var org Reported
	for _, t := range u.Teams {
		if t.TeamID == "" || t.TeamID == OrgKey {
			continue
		}
		r := Reported{Tokens: int64(t.Tokens), CostUSD: float64(t.CostUSD)}
		teams[t.TeamID] = r
		org.Tokens += r.Tokens
		org.CostUSD += r.CostUSD
	}
	teams[OrgKey] = org
	return u.Month, teams
}

type reportedMonth struct {
	month string
	teams map[string]Reported
}

// reported holds the latest report. Lock-free for the request path.
type reported struct{ p atomic.Pointer[reportedMonth] }

func (r *reported) SetReported(month string, teams map[string]Reported) {
	r.p.Store(&reportedMonth{month: month, teams: teams})
}

// get returns the team's reported usage for month, or zero when the report
// is for another month (or there is none yet).
func (r *reported) get(month, team string) (Reported, bool) {
	m := r.p.Load()
	if m == nil || m.month != month {
		return Reported{}, false
	}
	u := m.teams[team]
	return u, true
}

var overBudget = &policy.Violation{Status: http.StatusTooManyRequests, Code: "budget_exceeded",
	Message: "this team has spent its monthly budget"}

// OrgKey is the counter of the whole organization, kept by the enforcers
// beside its teams' (a team id is a UUID, so it never collides). The
// organization's plan caps it (ADR-0020).
const OrgKey = "@org"

var (
	orgExceeded = &policy.Violation{Status: http.StatusTooManyRequests, Code: "org_quota_exceeded",
		Message: "this organization has used its plan's monthly tokens"}
	orgOverBudget = &policy.Violation{Status: http.StatusTooManyRequests, Code: "org_budget_exceeded",
		Message: "this organization has spent its plan's monthly budget"}
)

// CheckOrg checks the organization's plan ceilings (limits from
// snapshot.OrgLimits) the way Check checks a team's, with their own codes
// so whoever is refused knows it is the plan and not the team.
func CheckOrg(e Enforcer, limits snapshot.Policy) *policy.Violation {
	switch v := e.Check(OrgKey, limits); v {
	case exceeded:
		return orgExceeded
	case overBudget:
		return orgOverBudget
	default:
		return v
	}
}

// checkBudget refuses a team that spent its monthly budget. Cost is only
// known to the control plane (it prices usage with the organization's
// rates), so this uses the reported spend; until a first report arrives
// for the current month the budget is not enforced.
func checkBudget(rep Reported, known bool, pol snapshot.Policy) *policy.Violation {
	if pol.MonthlyBudgetUSD == nil || !known {
		return nil
	}
	if rep.CostUSD >= *pol.MonthlyBudgetUSD {
		return overBudget
	}
	return nil
}
