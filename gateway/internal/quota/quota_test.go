package quota

import (
	"testing"
	"time"

	"github.com/getstratum/stratum/gateway/internal/snapshot"
)

func TestQuotaAndMonthRollover(t *testing.T) {
	now := time.Date(2026, 10, 31, 23, 0, 0, 0, time.UTC)
	l := NewLocal()
	l.now = func() time.Time { return now }

	limit := int64(100)
	pol := snapshot.Policy{MonthlyTokenQuota: &limit}

	l.Add("t1", 99)
	if v := l.Check("t1", pol); v != nil {
		t.Fatalf("99/100 must pass: %v", v)
	}
	l.Add("t1", 1)
	if v := l.Check("t1", pol); v == nil || v.Code != "quota_exceeded" {
		t.Fatalf("100/100 must be rejected: %v", v)
	}
	if v := l.Check("t2", pol); v != nil {
		t.Fatal("other teams are unaffected")
	}

	now = now.Add(2 * time.Hour) // November
	if v := l.Check("t1", pol); v != nil {
		t.Fatalf("counters must reset on a new month: %v", v)
	}
	if v := l.Check("t1", snapshot.Policy{}); v != nil {
		t.Fatal("no quota means unlimited")
	}
}
