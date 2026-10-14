package snapstore

import (
	"context"
	"errors"
	"os"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/getstratum/stratum/gateway/internal/snapshot"
	"github.com/getstratum/stratum/gateway/internal/valkey"
)

var key = []byte(strings.Repeat("k", 32))

// fake implements the two commands Store sends, with the script's logic.
type fake struct {
	mu      sync.Mutex
	h       map[string]map[string]string
	err     error
	onHMGET func()
}

func newFake() *fake { return &fake{h: map[string]map[string]string{}} }

func (f *fake) Do(_ context.Context, args ...string) (any, error) {
	f.mu.Lock()
	if f.err != nil {
		f.mu.Unlock()
		return nil, f.err
	}
	switch args[0] {
	case "EVAL":
		k, v, d, at, mode := args[3], args[4], args[5], args[6], args[7]
		defer f.mu.Unlock()
		if cur, ok := f.h[k]; ok && mode != "force" {
			cv, _ := strconv.ParseInt(cur["v"], 10, 64)
			nv, _ := strconv.ParseInt(v, 10, 64)
			if cv > nv || (cv == nv && mode != "full") {
				return int64(0), nil
			}
		}
		f.h[k] = map[string]string{"v": v, "d": d, "at": at}
		return int64(1), nil
	case "HMGET":
		hook := f.onHMGET
		cur, ok := f.h[args[1]]
		f.mu.Unlock()
		if hook != nil {
			hook()
		}
		if !ok {
			return []any{nil, nil, nil}, nil
		}
		return []any{cur["v"], cur["d"], cur["at"]}, nil
	}
	f.mu.Unlock()
	return nil, errors.New("unexpected command " + args[0])
}

func state(t *testing.T, version int64) *snapshot.State {
	t.Helper()
	st, err := (*snapshot.State)(nil).Apply(&snapshot.SyncResponse{CurrentVersion: snapshot.Int64(version)}, true)
	if err != nil {
		t.Fatal(err)
	}
	return st
}

func seal(t *testing.T, st *snapshot.State) []byte {
	t.Helper()
	b, err := snapshot.Seal(key, st)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func TestPutNewestWins(t *testing.T) {
	s := &Store{Client: newFake(), Key: Key("stratum", "dp_1")}
	ctx := context.Background()
	now := time.Unix(1_700_000_000, 0)
	put := func(v int64, mode Mode) bool {
		ok, err := s.Put(ctx, v, seal(t, state(t, v)), now, mode)
		if err != nil {
			t.Fatal(err)
		}
		return ok
	}
	if !put(5, ModeDelta) || !put(7, ModeDelta) {
		t.Fatal("newer versions must be stored")
	}
	if put(6, ModeDelta) || put(7, ModeDelta) || put(6, ModeFull) {
		t.Fatal("an older version, or an equal one from a delta, must not replace the stored copy")
	}
	if !put(7, ModeFull) {
		t.Fatal("a full resync must replace an equal version (changes that do not raise the version)")
	}
	if !put(3, ModeForce) {
		t.Fatal("a forced write must replace a newer version")
	}
	e, err := s.Get(ctx)
	if err != nil || e.Version != 3 || !e.SavedAt.Equal(now) {
		t.Fatalf("get: %v %+v", err, e)
	}
}

func TestBootstrap(t *testing.T) {
	ctx := context.Background()
	saved := time.Unix(1_700_000_000, 0)

	t.Run("loads the shared copy when the control plane does not answer", func(t *testing.T) {
		s := &Store{Client: newFake(), Key: "k"}
		s.Put(ctx, 5, seal(t, state(t, 5)), saved, ModeDelta)
		var h snapshot.Holder
		out, st, err := Bootstrap(ctx, &h, h.State(), s, key, 20*time.Millisecond, 5*time.Millisecond)
		if out != Loaded || err != nil || st.Version != 5 || h.State() != st {
			t.Fatalf("out=%v err=%v", out, err)
		}
		if !h.Load().SyncedAt.Equal(saved) {
			t.Fatalf("snapshot age must count from when the copy was saved, got %v", h.Load().SyncedAt)
		}
	})

	t.Run("does nothing when the control plane answers first", func(t *testing.T) {
		s := &Store{Client: newFake(), Key: "k"}
		s.Put(ctx, 9, seal(t, state(t, 9)), saved, ModeDelta)
		var h snapshot.Holder
		fresh := state(t, 4)
		go func() { time.Sleep(5 * time.Millisecond); h.Store(fresh, snapshot.Build(fresh, time.Now())) }()
		out, _, _ := Bootstrap(ctx, &h, h.State(), s, key, time.Second, time.Millisecond)
		if out != Synced || h.State() != fresh {
			t.Fatalf("out=%v; the control plane's configuration must win even with a lower version", out)
		}
	})

	t.Run("a sync that lands before Bootstrap starts is not mistaken for the starting point", func(t *testing.T) {
		s := &Store{Client: newFake(), Key: "k"}
		s.Put(ctx, 9, seal(t, state(t, 9)), saved, ModeDelta)
		var h snapshot.Holder
		base := h.State() // read before the control plane sync starts
		fresh := state(t, 4)
		h.Store(fresh, snapshot.Build(fresh, time.Now()))
		out, _, _ := Bootstrap(ctx, &h, base, s, key, 50*time.Millisecond, time.Millisecond)
		if out != Synced || h.State() != fresh {
			t.Fatalf("out=%v", out)
		}
	})

	t.Run("keeps a newer snapshot restored from disk", func(t *testing.T) {
		s := &Store{Client: newFake(), Key: "k"}
		s.Put(ctx, 5, seal(t, state(t, 5)), saved, ModeDelta)
		var h snapshot.Holder
		disk := state(t, 7)
		h.Store(disk, snapshot.Build(disk, saved))
		out, _, _ := Bootstrap(ctx, &h, h.State(), s, key, time.Millisecond, time.Millisecond)
		if out != NotNewer || h.State() != disk {
			t.Fatalf("out=%v", out)
		}
	})

	t.Run("replaces an older snapshot restored from disk", func(t *testing.T) {
		s := &Store{Client: newFake(), Key: "k"}
		s.Put(ctx, 8, seal(t, state(t, 8)), saved, ModeDelta)
		var h snapshot.Holder
		disk := state(t, 7)
		h.Store(disk, snapshot.Build(disk, saved))
		out, st, _ := Bootstrap(ctx, &h, h.State(), s, key, time.Millisecond, time.Millisecond)
		if out != Loaded || st.Version != 8 {
			t.Fatalf("out=%v", out)
		}
	})

	t.Run("missing copy", func(t *testing.T) {
		var h snapshot.Holder
		out, _, _ := Bootstrap(ctx, &h, h.State(), &Store{Client: newFake(), Key: "k"}, key, time.Millisecond, time.Millisecond)
		if out != Missing || h.Load() != nil {
			t.Fatalf("out=%v", out)
		}
	})

	t.Run("wrong key or unreachable store leave the gateway waiting", func(t *testing.T) {
		s := &Store{Client: newFake(), Key: "k"}
		s.Put(ctx, 5, seal(t, state(t, 5)), saved, ModeDelta)
		var h snapshot.Holder
		out, _, err := Bootstrap(ctx, &h, h.State(), s, []byte(strings.Repeat("x", 32)), time.Millisecond, time.Millisecond)
		if out != Failed || err == nil || h.Load() != nil {
			t.Fatalf("wrong key: out=%v err=%v", out, err)
		}
		down := newFake()
		down.err = errors.New("connection refused")
		out, _, err = Bootstrap(ctx, &h, h.State(), &Store{Client: down, Key: "k"}, key, time.Millisecond, time.Millisecond)
		if out != Failed || err == nil || h.Load() != nil {
			t.Fatalf("store down: out=%v err=%v", out, err)
		}
	})

	t.Run("never overwrites a sync that lands while the copy is read", func(t *testing.T) {
		f := newFake()
		s := &Store{Client: f, Key: "k"}
		s.Put(ctx, 9, seal(t, state(t, 9)), saved, ModeDelta)
		var h snapshot.Holder
		fresh := state(t, 4)
		f.onHMGET = func() { h.Store(fresh, snapshot.Build(fresh, time.Now())) }
		out, _, _ := Bootstrap(ctx, &h, h.State(), s, key, time.Millisecond, time.Millisecond)
		if out != Synced || h.State() != fresh {
			t.Fatalf("out=%v", out)
		}
	})
}

// TestAgainstValkey runs the real Lua script. CI provides a Valkey service;
// locally: STRATUM_TEST_VALKEY_URL=redis://localhost:6379/15.
func TestAgainstValkey(t *testing.T) {
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
	s := &Store{Client: c, Key: Key("stratum-test-"+strconv.FormatInt(time.Now().UnixNano(), 36), "dp_1")}
	defer c.Do(ctx, "DEL", s.Key)

	if _, err := s.Get(ctx); !errors.Is(err, ErrNotFound) {
		t.Fatalf("empty store: %v", err)
	}
	now := time.Unix(1_700_000_000, 0)
	for _, tc := range []struct {
		version int64
		mode    Mode
		want    bool
	}{
		{5, ModeDelta, true}, {7, ModeDelta, true}, {6, ModeDelta, false}, {7, ModeDelta, false},
		{6, ModeFull, false}, {7, ModeFull, true}, {3, ModeForce, true}, {4, ModeDelta, true},
	} {
		ok, err := s.Put(ctx, tc.version, seal(t, state(t, tc.version)), now, tc.mode)
		if err != nil || ok != tc.want {
			t.Fatalf("put v%d %s: stored=%v err=%v, want %v", tc.version, tc.mode, ok, err, tc.want)
		}
	}
	e, err := s.Get(ctx)
	if err != nil || e.Version != 4 || !e.SavedAt.Equal(now) {
		t.Fatalf("get: %v %+v", err, e)
	}
	// The blob is binary (nonce, ciphertext) and must come back intact.
	st, err := snapshot.Open(key, e.Sealed)
	if err != nil || st.Version != 4 {
		t.Fatalf("open after round trip: %v", err)
	}
}
