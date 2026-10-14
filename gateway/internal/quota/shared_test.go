package quota

import (
	"context"
	"errors"
	"os"
	"strconv"
	"sync"
	"testing"
	"time"

	"github.com/getstratum/stratum/gateway/internal/snapshot"
	"github.com/getstratum/stratum/gateway/internal/valkey"
)

// fakeStore emulates flushScript in Go. failBefore drops the command without
// applying it; failAfter applies it and then loses the reply, the ambiguous
// case that idempotency has to cover.
type fakeStore struct {
	mu         sync.Mutex
	kv         map[string]int64
	failBefore bool
	failAfter  bool
	evals      int
}

func newFakeStore() *fakeStore { return &fakeStore{kv: map[string]int64{}} }

var errDown = errors.New("connection refused")

func (f *fakeStore) Do(_ context.Context, args ...string) (any, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.failBefore {
		return nil, errDown
	}
	switch args[0] {
	case "PING":
		return "PONG", nil
	case "EVAL":
	default:
		return nil, valkey.Error("ERR unknown command")
	}
	f.evals++
	n, _ := strconv.Atoi(args[2])
	keys := args[3 : 3+n]
	argv := args[3+n:]
	seq, _ := strconv.ParseInt(argv[0], 10, 64)
	apply := seq > f.kv[keys[0]]
	out := make([]any, 0, n-1)
	for i, k := range keys[1:] {
		d, _ := strconv.ParseInt(argv[2+i], 10, 64)
		if apply && d != 0 {
			f.kv[k] += d
		}
		out = append(out, f.kv[k])
	}
	if apply {
		f.kv[keys[0]] = seq
	}
	if f.failAfter {
		return nil, errors.New("i/o timeout")
	}
	return out, nil
}

func (f *fakeStore) set(before, after bool) {
	f.mu.Lock()
	f.failBefore, f.failAfter = before, after
	f.mu.Unlock()
}

func (f *fakeStore) total(month, team string) int64 {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.kv["stratum:{quota}:tok:"+month+":"+team]
}

func newTestShared(c Doer, now *time.Time, failClosed bool) *Shared {
	s := NewShared(SharedOptions{Client: c, FailClosed: failClosed})
	s.now = func() time.Time { return *now }
	return s
}

func quotaPolicy(n int64) snapshot.Policy { return snapshot.Policy{MonthlyTokenQuota: &n} }

func mustFlush(t *testing.T, s *Shared) {
	t.Helper()
	if err := s.Flush(context.Background()); err != nil {
		t.Fatalf("flush: %v", err)
	}
}

func TestSharedCountsAcrossReplicas(t *testing.T) {
	now := time.Date(2026, 10, 14, 12, 0, 0, 0, time.UTC)
	store := newFakeStore()
	a := newTestShared(store, &now, false)
	b := newTestShared(store, &now, false)
	pol := quotaPolicy(100)

	// Both replicas serve the team.
	if a.Check("t1", pol) != nil || b.Check("t1", pol) != nil {
		t.Fatal("fresh team must pass")
	}
	a.Add("t1", 60)
	b.Add("t1", 30)
	if v := a.Check("t1", pol); v != nil {
		t.Fatalf("a alone sees 60/100: %v", v)
	}
	mustFlush(t, a)
	mustFlush(t, b)
	mustFlush(t, a) // a learns b's usage
	if got := a.Used("t1"); got != 90 {
		t.Fatalf("a sees %d, want fleet total 90", got)
	}
	b.Add("t1", 10)
	if v := b.Check("t1", pol); v == nil || v.Code != "quota_exceeded" {
		t.Fatalf("b must reject at 100/100 fleet-wide, got %v", v)
	}
	mustFlush(t, b)
	mustFlush(t, a)
	if v := a.Check("t1", pol); v == nil {
		t.Fatal("a must reject too once it refreshes")
	}
	if got := store.total("2026-10", "t1"); got != 100 {
		t.Fatalf("store has %d, want 100", got)
	}
}

func TestSharedAmbiguousFailureIsNotCountedTwice(t *testing.T) {
	now := time.Date(2026, 10, 14, 12, 0, 0, 0, time.UTC)
	store := newFakeStore()
	s := newTestShared(store, &now, false)

	s.Add("t1", 50)
	store.set(false, true) // applied, reply lost
	if err := s.Flush(context.Background()); err == nil {
		t.Fatal("expected a flush error")
	}
	s.Add("t1", 5) // new usage while the batch is unacknowledged
	store.set(false, false)
	mustFlush(t, s) // retries the same batch: must not apply again
	if got := store.total("2026-10", "t1"); got != 50 {
		t.Fatalf("after retry store has %d, want 50", got)
	}
	if got := s.Used("t1"); got != 55 {
		t.Fatalf("replica sees %d, want 55 (50 confirmed + 5 pending)", got)
	}
	mustFlush(t, s)
	if got := store.total("2026-10", "t1"); got != 55 {
		t.Fatalf("store has %d, want 55", got)
	}
	if got := s.Used("t1"); got != 55 {
		t.Fatalf("replica sees %d, want 55", got)
	}
}

func TestSharedOutageFallsBackAndReconciles(t *testing.T) {
	now := time.Date(2026, 10, 14, 12, 0, 0, 0, time.UTC)
	store := newFakeStore()
	s := newTestShared(store, &now, false)
	pol := quotaPolicy(100)

	s.Check("t1", pol)
	s.Add("t1", 40)
	mustFlush(t, s)

	store.set(true, false) // store down
	for i := 0; i < 5; i++ {
		now = now.Add(time.Minute)
		s.Add("t1", 10)
		s.Flush(context.Background())
	}
	// Fail open: still enforcing against 40 confirmed + 50 local.
	if v := s.Check("t1", pol); v != nil {
		t.Fatalf("90/100 must pass during an outage: %v", v)
	}
	s.Add("t1", 10)
	if v := s.Check("t1", pol); v == nil || v.Code != "quota_exceeded" {
		t.Fatalf("local counting must still enforce during an outage: %v", v)
	}

	store.set(false, false)
	mustFlush(t, s)
	mustFlush(t, s)
	if got := store.total("2026-10", "t1"); got != 100 {
		t.Fatalf("store has %d after recovery, want 100", got)
	}
}

func TestSharedFailClosed(t *testing.T) {
	now := time.Date(2026, 10, 14, 12, 0, 0, 0, time.UTC)
	store := newFakeStore()
	s := newTestShared(store, &now, true)
	pol := quotaPolicy(100)

	if v := s.Check("t1", pol); v == nil || v.Code != "quota_unavailable" {
		t.Fatalf("before the first flush the store is unknown: %v", v)
	}
	mustFlush(t, s)
	if v := s.Check("t1", pol); v != nil {
		t.Fatalf("fresh store must pass: %v", v)
	}
	if v := s.Check("t2", snapshot.Policy{}); v != nil {
		t.Fatal("teams without a quota are never rejected")
	}
	store.set(true, false)
	now = now.Add(31 * time.Second)
	s.Flush(context.Background())
	if v := s.Check("t1", pol); v == nil || v.Status != 503 {
		t.Fatalf("stale store must fail closed: %v", v)
	}
}

func TestSharedMonthRollover(t *testing.T) {
	now := time.Date(2026, 10, 31, 23, 59, 0, 0, time.UTC)
	store := newFakeStore()
	s := newTestShared(store, &now, false)
	pol := quotaPolicy(100)

	s.Check("t1", pol)
	s.Add("t1", 100)
	if s.Check("t1", pol) == nil {
		t.Fatal("100/100 must be rejected")
	}
	now = now.Add(2 * time.Minute) // November; October usage still unflushed
	if v := s.Check("t1", pol); v != nil {
		t.Fatalf("new month starts at zero: %v", v)
	}
	s.Add("t1", 7)
	mustFlush(t, s)
	if got := store.total("2026-10", "t1"); got != 100 {
		t.Fatalf("October usage must land in October, got %d", got)
	}
	if got := store.total("2026-11", "t1"); got != 7 {
		t.Fatalf("November has %d, want 7", got)
	}
	if got := s.Used("t1"); got != 7 {
		t.Fatalf("replica sees %d in November, want 7", got)
	}
}

func TestSharedBatchSizeIsBounded(t *testing.T) {
	now := time.Date(2026, 10, 14, 12, 0, 0, 0, time.UTC)
	store := newFakeStore()
	s := NewShared(SharedOptions{Client: store, MaxKeys: 2})
	s.now = func() time.Time { return now }
	for i := range 5 {
		s.Add("t"+strconv.Itoa(i), 1)
	}
	for range 3 {
		mustFlush(t, s)
	}
	for i := range 5 {
		if got := store.total("2026-10", "t"+strconv.Itoa(i)); got != 1 {
			t.Fatalf("t%d has %d, want 1", i, got)
		}
	}
}

func TestSharedDrainOnShutdown(t *testing.T) {
	store := newFakeStore()
	s := NewShared(SharedOptions{Client: store, Interval: time.Hour})
	s.Add("t1", 42)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { s.Run(ctx, time.Second); close(done) }()
	cancel()
	<-done
	if got := store.total(Month(time.Now()), "t1"); got != 42 {
		t.Fatalf("usage must be flushed on shutdown, store has %d", got)
	}
}

// TestSharedAgainstValkey runs the real Lua script. CI provides a Valkey
// service; locally: STRATUM_TEST_VALKEY_URL=redis://localhost:6379/15.
func TestSharedAgainstValkey(t *testing.T) {
	raw := os.Getenv("STRATUM_TEST_VALKEY_URL")
	if raw == "" {
		t.Skip("STRATUM_TEST_VALKEY_URL not set")
	}
	o, err := valkey.ParseURL(raw)
	if err != nil {
		t.Fatal(err)
	}
	c := valkey.New(o)
	defer c.Close()
	ctx := context.Background()
	prefix := "stratum-test-" + strconv.FormatInt(time.Now().UnixNano(), 36)

	mk := func() *Shared { return NewShared(SharedOptions{Client: c, Prefix: prefix}) }
	a, b := mk(), mk()
	pol := quotaPolicy(1000)
	a.Check("team", pol)
	b.Check("team", pol)
	a.Add("team", 300)
	b.Add("team", 200)
	for _, s := range []*Shared{a, b, a} {
		if err := s.Flush(ctx); err != nil {
			t.Fatal(err)
		}
	}
	if got := a.Used("team"); got != 500 {
		t.Fatalf("a sees %d, want 500", got)
	}

	// Replaying an applied batch must not count again.
	a.Add("team", 1)
	a.mu.Lock()
	a.batch = a.nextBatch(time.Now())
	replay := *a.batch
	a.mu.Unlock()
	if err := a.Flush(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := a.send(ctx, &replay); err != nil {
		t.Fatal(err)
	}
	key := prefix + ":{quota}:tok:" + Month(time.Now()) + ":team"
	v, err := c.Do(ctx, "GET", key)
	if err != nil {
		t.Fatal(err)
	}
	if n, _ := valkey.Int(v); n != 501 {
		t.Fatalf("store has %d, want 501", n)
	}
	ttl, err := c.Do(ctx, "TTL", key)
	if err != nil {
		t.Fatal(err)
	}
	if n, _ := valkey.Int(ttl); n <= 0 {
		t.Fatalf("counter must expire, TTL=%d", n)
	}
	c.Do(ctx, "DEL", key, prefix+":{quota}:seq:"+a.replica, prefix+":{quota}:seq:"+b.replica)
}

func TestSharedDetectsCounterRegression(t *testing.T) {
	now := time.Date(2026, 10, 14, 12, 0, 0, 0, time.UTC)
	store := newFakeStore()
	s := newTestShared(store, &now, false)
	s.Check("t1", quotaPolicy(100))
	s.Add("t1", 80)
	mustFlush(t, s)

	store.mu.Lock()
	clear(store.kv) // Valkey restarted without persistence
	store.mu.Unlock()
	mustFlush(t, s)
	if got := s.o.Metrics.QuotaStoreRegressions.Load(); got != 1 {
		t.Fatalf("regressions = %d, want 1", got)
	}
	if got := s.Used("t1"); got != 0 {
		t.Fatalf("the store wins after a reset; replica sees %d", got)
	}
}
