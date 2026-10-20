// Package quota tracks monthly token usage per team.
//
// Two implementations share one interface:
//
//   - Local keeps counters in process memory. It is exact for a single
//     replica and resets on restart.
//   - Shared keeps the authoritative counters in Valkey/Redis, so every
//     replica enforces against the fleet-wide total. Valkey is never on the
//     request path: checks read an in-memory copy that a background loop
//     refreshes, and when Valkey is unreachable the gateway keeps counting
//     locally and catches up when it returns (docs/adr/0004).
//
// Both also take the usage the control plane reports with each sync
// (Reported): a team's tokens are the larger of what this gateway counted
// and what the control plane counted, so a restart, a replica that counts on
// its own or another gateway of the organization does not reset the month.
// The monthly budget in USD is enforced with the reported spend only: the
// control plane prices usage, the gateway does not.
package quota

import (
	"net/http"
	"sync"
	"time"

	"github.com/getstratum/stratum/gateway/internal/policy"
	"github.com/getstratum/stratum/gateway/internal/snapshot"
)

// Enforcer is what the request path uses. Check must not block on I/O.
type Enforcer interface {
	// Check returns a violation when the team may not start another request.
	Check(teamID string, pol snapshot.Policy) *policy.Violation
	// Add records tokens consumed by a finished request.
	Add(teamID string, tokens int64)
	ReportedSetter
}

var exceeded = &policy.Violation{Status: http.StatusTooManyRequests, Code: "quota_exceeded",
	Message: "this team has used its monthly token quota"}

// Month is the UTC calendar month a counter belongs to, as "2006-01".
func Month(t time.Time) string { return t.UTC().Format("2006-01") }

// Local counts in process memory.
type Local struct {
	reported
	mu     sync.Mutex
	month  string
	tokens map[string]int64
	now    func() time.Time
}

func NewLocal() *Local { return &Local{tokens: map[string]int64{}, now: time.Now} }

// Check returns a violation when the team has used up its monthly tokens.
func (l *Local) Check(teamID string, pol snapshot.Policy) *policy.Violation {
	if pol.MonthlyTokenQuota == nil && pol.MonthlyBudgetUSD == nil {
		return nil
	}
	l.mu.Lock()
	l.rollover()
	used := l.tokens[teamID]
	month := l.month
	l.mu.Unlock()
	rep, known := l.get(month, teamID)
	if pol.MonthlyTokenQuota != nil && max(used, rep.Tokens) >= *pol.MonthlyTokenQuota {
		return exceeded
	}
	return checkBudget(rep, known, pol)
}

// Add records tokens consumed by a finished request.
func (l *Local) Add(teamID string, tokens int64) {
	if tokens <= 0 {
		return
	}
	l.mu.Lock()
	l.rollover()
	l.tokens[teamID] += tokens
	l.mu.Unlock()
}

// Used returns the tokens a team has consumed this month: the larger of this
// gateway's count and the control plane's.
func (l *Local) Used(teamID string) int64 {
	l.mu.Lock()
	l.rollover()
	used, month := l.tokens[teamID], l.month
	l.mu.Unlock()
	rep, _ := l.get(month, teamID)
	return max(used, rep.Tokens)
}

func (l *Local) rollover() {
	m := Month(l.now())
	if m != l.month {
		l.month = m
		clear(l.tokens)
	}
}
