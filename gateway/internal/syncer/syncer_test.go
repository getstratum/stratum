package syncer

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/getstratum/stratum/gateway/internal/metrics"
	"github.com/getstratum/stratum/gateway/internal/snapshot"
)

// fakeCP serves canned sync responses keyed by since_version == 0 (full) or not.
type fakeCP struct {
	mu     sync.Mutex
	full   string
	delta  string
	status int
	calls  []string
}

func (f *fakeCP) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, r.URL.Query().Get("since_version"))
	if r.Header.Get("Authorization") != "Bearer tok" {
		w.WriteHeader(http.StatusUnauthorized)
		return
	}
	if f.status != 0 {
		w.WriteHeader(f.status)
		return
	}
	if r.URL.Query().Get("since_version") == "0" {
		io.WriteString(w, f.full)
	} else {
		io.WriteString(w, f.delta)
	}
}

func newCP(t *testing.T, f *fakeCP) (*ControlPlane, *snapshot.Holder, *time.Time) {
	srv := httptest.NewServer(f)
	t.Cleanup(srv.Close)
	h := &snapshot.Holder{}
	now := time.Date(2026, 10, 13, 12, 0, 0, 0, time.UTC)
	c := &ControlPlane{
		URL: srv.URL, Token: "tok", InstanceID: "dp_1",
		Interval: 30 * time.Second, FullEvery: 10 * time.Minute,
		MaxDropRatio: 0.5, GuardMinKeys: 2,
		Holder: h, Client: srv.Client(),
		Log:     slog.New(slog.NewTextHandler(io.Discard, nil)),
		Metrics: metrics.New(),
		now:     func() time.Time { return now },
	}
	return c, h, &now
}

func keysJSON(version int, ids ...string) string {
	var parts []string
	for _, id := range ids {
		parts = append(parts, fmt.Sprintf(`{"id":%q,"key_hash":"%s","team_id":"t1","version":%d,"revoked":false}`,
			id, strings.Repeat(id[:1], 64), version))
	}
	return fmt.Sprintf(`{"current_version":"%d","next_sync_in_seconds":30,"policies":[],"api_keys":[%s],"provider_configs":[]}`,
		version, strings.Join(parts, ","))
}

func TestFirstSyncIsFullThenDeltas(t *testing.T) {
	f := &fakeCP{full: keysJSON(5, "a1", "b1"), delta: keysJSON(6, "c1")}
	c, h, _ := newCP(t, f)
	persisted := 0
	c.Persist = func(_, _ *snapshot.State, _ bool) { persisted++ }

	if _, _, err := c.SyncOnce(context.Background(), false); err != nil {
		t.Fatal(err)
	}
	if _, _, err := c.SyncOnce(context.Background(), false); err != nil {
		t.Fatal(err)
	}
	if got := f.calls; len(got) != 2 || got[0] != "0" || got[1] != "5" {
		t.Fatalf("since_version sequence = %v", got)
	}
	if h.Load().ActiveKeys() != 3 || h.Load().Version != 6 {
		t.Fatalf("snapshot after delta: keys=%d version=%d", h.Load().ActiveKeys(), h.Load().Version)
	}
	if persisted != 2 {
		t.Fatalf("persisted %d times", persisted)
	}
}

func TestPeriodicFullResyncAndGuard(t *testing.T) {
	f := &fakeCP{full: keysJSON(5, "a1", "b1", "c1", "d1"), delta: keysJSON(5)}
	c, h, now := newCP(t, f)
	c.SyncOnce(context.Background(), false)

	// Ten minutes later the CP returns a full state missing 3 of 4 keys.
	f.full = keysJSON(9, "a1")
	*now = now.Add(11 * time.Minute)
	_, _, err := c.SyncOnce(context.Background(), false)
	if !errors.Is(err, snapshot.ErrSuspiciousChange) {
		t.Fatalf("expected guard rejection, got %v", err)
	}
	if h.Load().ActiveKeys() != 4 {
		t.Fatal("rejected resync must not replace the snapshot")
	}
	if c.Metrics.GuardRejected.Load() != 1 {
		t.Fatal("guard rejection not counted")
	}
}

func TestVersionRegressionForcesFullResync(t *testing.T) {
	f := &fakeCP{full: keysJSON(50, "a1"), delta: keysJSON(10)}
	c, _, _ := newCP(t, f)
	c.SyncOnce(context.Background(), false)

	_, needFull, err := c.SyncOnce(context.Background(), false)
	if err != nil || !needFull {
		t.Fatalf("regression must request a full resync, got needFull=%v err=%v", needFull, err)
	}
}

func TestFailureKeepsServing(t *testing.T) {
	f := &fakeCP{full: keysJSON(5, "a1")}
	c, h, _ := newCP(t, f)
	c.SyncOnce(context.Background(), false)

	f.status = http.StatusInternalServerError
	if _, _, err := c.SyncOnce(context.Background(), false); err == nil {
		t.Fatal("expected an error")
	}
	if h.Load() == nil || h.Load().ActiveKeys() != 1 {
		t.Fatal("a failed sync must leave the snapshot in place")
	}
	if c.Metrics.SyncFailure.Load() != 1 {
		t.Fatal("failure not counted")
	}
}

func TestBackoffCaps(t *testing.T) {
	if backoff(1) != time.Second || backoff(3) != 4*time.Second || backoff(50) != 2*time.Minute {
		t.Fatal("unexpected backoff curve")
	}
}

func TestLoadStatic(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "stratum.json")
	os.WriteFile(path, []byte(`{
	  "current_version": 1,
	  "policies": [{"id":"p","team_id":"t1","version":1,"allow_all_models":true}],
	  "api_keys": [{"id":"k","key_hash":"`+strings.Repeat("a", 64)+`","team_id":"t1","version":1,"revoked":false}],
	  "provider_configs": [{"id":"oa","provider":"openai","api_key":"env:OA_KEY","enabled":true,"version":1,"revoked":false}]
	}`), 0o600)

	st, err := LoadStatic(path, func(k string) string { return map[string]string{"OA_KEY": "sk-1"}[k] })
	if err != nil {
		t.Fatal(err)
	}
	if *st.Providers["oa"].APIKey != "sk-1" {
		t.Fatal("env reference not resolved")
	}
	if _, err := LoadStatic(path, func(string) string { return "" }); err == nil {
		t.Fatal("missing env var must fail")
	}

	os.WriteFile(path, []byte(`{"current_version":1,"polices":[]}`), 0o600)
	if _, err := LoadStatic(path, os.Getenv); err == nil {
		t.Fatal("unknown field (typo) must fail")
	}
}

func TestMonthUsageIsHandedOnEverySync(t *testing.T) {
	withUsage := func(s string) string {
		return strings.TrimSuffix(s, "}") + `,"month_usage":{"month":"2026-10","teams":[{"team_id":"t1","tokens":"1200","cost_usd":"3.25"}]}}`
	}
	f := &fakeCP{full: withUsage(keysJSON(5, "a1", "b1")), delta: keysJSON(5)}
	c, _, _ := newCP(t, f)
	var got []*snapshot.WireMonthUsage
	c.MonthUsage = func(u *snapshot.WireMonthUsage) { got = append(got, u) }

	if _, _, err := c.SyncOnce(context.Background(), false); err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].Month != "2026-10" || got[0].Teams[0].Tokens != 1200 || got[0].Teams[0].CostUSD != 3.25 {
		t.Fatalf("full sync: %+v", got)
	}
	if c.Metrics.MonthUsageReported.Load() == 0 {
		t.Fatal("the time of the report is exported")
	}
	// A control plane before 0.3 sends no month_usage: nothing is handed on,
	// so the last report stays.
	if _, _, err := c.SyncOnce(context.Background(), false); err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 {
		t.Fatalf("a sync without month_usage must not call MonthUsage: %d calls", len(got))
	}
	// A delta with no configuration change still carries it.
	f.mu.Lock()
	f.delta = withUsage(keysJSON(5))
	f.mu.Unlock()
	if _, _, err := c.SyncOnce(context.Background(), false); err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 {
		t.Fatalf("delta: %d calls", len(got))
	}
}
