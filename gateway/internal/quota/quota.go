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
// Budget in USD is not enforced yet: the gateway needs a model price table
// from the control plane first.
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
}

var exceeded = &policy.Violation{Status: http.StatusTooManyRequests, Code: "quota_exceeded",
	Message: "this team has used its monthly token quota"}

// Month is the UTC calendar month a counter belongs to, as "2006-01".
func Month(t time.Time) string { return t.UTC().Format("2006-01") }

// Local counts in process memory.
type Local struct {
	mu     sync.Mutex
	month  string
	tokens map[string]int64
	now    func() time.Time
}

func NewLocal() *Local { return &Local{tokens: map[string]int64{}, now: time.Now} }

// Check returns a violation when the team has used up its monthly tokens.
func (l *Local) Check(teamID string, pol snapshot.Policy) *policy.Violation {
	if pol.MonthlyTokenQuota == nil {
		return nil
	}
	l.mu.Lock()
	l.rollover()
	used := l.tokens[teamID]
	l.mu.Unlock()
	if used >= *pol.MonthlyTokenQuota {
		return exceeded
	}
	return nil
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

// Used returns the tokens a team has consumed this month.
func (l *Local) Used(teamID string) int64 {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.rollover()
	return l.tokens[teamID]
}

func (l *Local) rollover() {
	m := Month(l.now())
	if m != l.month {
		l.month = m
		clear(l.tokens)
	}
}
