// Package quota tracks monthly token usage per team.
//
// This first implementation keeps counters in process memory. With several
// replicas each one enforces against its own counters, and counters reset on
// restart, so enforcement is approximate. A shared Valkey/Redis backend that
// degrades to these local counters when unreachable is the next step (see
// docs/adr/0004). Budget in USD is not enforced yet: the gateway needs a
// model price table from the control plane first.
package quota

import (
	"net/http"
	"sync"
	"time"

	"github.com/getstratum/stratum/gateway/internal/policy"
	"github.com/getstratum/stratum/gateway/internal/snapshot"
)

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
		return &policy.Violation{Status: http.StatusTooManyRequests, Code: "quota_exceeded",
			Message: "this team has used its monthly token quota"}
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
	m := l.now().UTC().Format("2006-01")
	if m != l.month {
		l.month = m
		clear(l.tokens)
	}
}
