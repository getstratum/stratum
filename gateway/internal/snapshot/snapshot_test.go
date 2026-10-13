package snapshot

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func mustDecode(t *testing.T, js string) *SyncResponse {
	t.Helper()
	var r SyncResponse
	if err := json.Unmarshal([]byte(js), &r); err != nil {
		t.Fatalf("decode: %v", err)
	}
	return &r
}

// node-postgres sends BIGINT and DECIMAL as strings; both must decode.
func TestDecodeAcceptsNumericStrings(t *testing.T) {
	r := mustDecode(t, `{
	  "current_version": "42",
	  "next_sync_in_seconds": 30,
	  "policies": [{"id":"pol_1","team_id":"t1","version":"35","allowed_models":["gpt-4o"],
	                "allow_all_models":false,"monthly_token_quota":"1000000","monthly_budget_usd":"100.00",
	                "pii_action":"redact","revoked":false}],
	  "api_keys": [{"id":"u1","key_hash":"ABC","team_id":"t1","version":28,"revoked":false}],
	  "provider_configs": []
	}`)
	if r.CurrentVersion != 42 || r.Policies[0].Version != 35 {
		t.Fatalf("versions: %+v", r)
	}
	if *r.Policies[0].MonthlyTokenQuota != 1000000 || *r.Policies[0].MonthlyBudgetUSD != 100 {
		t.Fatalf("quota/budget: %+v", r.Policies[0])
	}
}

func TestApplyDeltaKeepsHigherVersion(t *testing.T) {
	base, err := (*State)(nil).Apply(mustDecode(t, `{"current_version":10,
	  "api_keys":[{"id":"u1","key_hash":"h1","team_id":"t1","version":10,"revoked":false}]}`), true)
	if err != nil {
		t.Fatal(err)
	}
	// An older copy arriving late must not overwrite the newer one.
	next, err := base.Apply(mustDecode(t, `{"current_version":10,
	  "api_keys":[{"id":"u1","key_hash":"OLD","team_id":"t1","version":3,"revoked":false}]}`), false)
	if err != nil {
		t.Fatal(err)
	}
	if next.APIKeys["u1"].KeyHash != "h1" {
		t.Fatalf("stale delta overwrote newer key: %+v", next.APIKeys["u1"])
	}
	if base.APIKeys["u1"].KeyHash != "h1" {
		t.Fatal("Apply mutated its receiver")
	}
}

func TestBuildIndexesAndSkipsRevoked(t *testing.T) {
	st, _ := (*State)(nil).Apply(mustDecode(t, `{"current_version":5,
	  "policies":[{"id":"p","team_id":"t1","version":1,"allowed_models":["gpt-4o"],"pii_action":"BLOCK"}],
	  "api_keys":[
	    {"id":"u1","key_hash":"AAAA","team_id":"t1","version":1,"revoked":false},
	    {"id":"u2","key_hash":"bbbb","team_id":"t1","version":2,"revoked":true}],
	  "provider_configs":[
	    {"id":"pc_b","provider":"openai","api_key":"sk-b","enabled":true,"version":3,"revoked":false},
	    {"id":"pc_a","provider":"OpenAI","api_key":"sk-a","base_url":"https://x/","enabled":true,"version":4,"revoked":false},
	    {"id":"pc_c","provider":"groq","api_key":"g","enabled":false,"version":5,"revoked":false}]}`), true)
	s := Build(st, time.Now())

	if _, ok := s.KeyByHash("aaaa"); !ok {
		t.Fatal("key hash lookup must be case-insensitive on the stored side")
	}
	if _, ok := s.KeyByHash("bbbb"); ok {
		t.Fatal("revoked key must not resolve")
	}
	if s.ActiveKeys() != 1 {
		t.Fatalf("active keys = %d", s.ActiveKeys())
	}
	p, _ := s.PolicyForTeam("t1")
	if p.PIIAction != "block" || p.DLPAction != "off" {
		t.Fatalf("actions not normalized: %+v", p)
	}
	prov, ok := s.Provider("openai")
	if !ok || prov.ID != "pc_a" || prov.BaseURL != "https://x" {
		t.Fatalf("provider choice not deterministic or base url not trimmed: %+v", prov)
	}
	if _, ok := s.Provider("groq"); ok {
		t.Fatal("disabled provider must not resolve")
	}
}

func TestGuard(t *testing.T) {
	keys := func(n int, revokedFrom int) *SyncResponse {
		r := &SyncResponse{CurrentVersion: 1}
		for i := 0; i < n; i++ {
			r.APIKeys = append(r.APIKeys, WireAPIKey{
				ID: "u" + string(rune('a'+i)), KeyHash: "h" + string(rune('a'+i)), TeamID: "t", Version: 1,
				Revoked: i >= revokedFrom,
			})
		}
		return r
	}
	prev, _ := (*State)(nil).Apply(keys(20, 20), true)

	vanished, _ := (*State)(nil).Apply(keys(5, 5), true)
	if err := Guard(prev, vanished, 0.5, 10); !errors.Is(err, ErrSuspiciousChange) {
		t.Fatalf("15/20 keys vanishing must be rejected, got %v", err)
	}

	// Same outcome reached through explicit revocations is an operator's
	// decision (e.g. incident response) and must pass.
	revoked, _ := (*State)(nil).Apply(keys(20, 2), true)
	if err := Guard(prev, revoked, 0.5, 10); err != nil {
		t.Fatalf("explicit mass revocation must pass, got %v", err)
	}

	small, _ := (*State)(nil).Apply(keys(4, 4), true)
	tiny, _ := (*State)(nil).Apply(keys(0, 0), true)
	if err := Guard(small, tiny, 0.5, 10); err != nil {
		t.Fatalf("installations below minKeys skip the ratio check, got %v", err)
	}
}

func TestPersistRoundTrip(t *testing.T) {
	key := []byte(strings.Repeat("k", 32))
	path := filepath.Join(t.TempDir(), "sub", "snapshot.bin")
	secret := "sk-very-secret"
	st, _ := (*State)(nil).Apply(&SyncResponse{CurrentVersion: 7, ProviderConfigs: []WireProviderConfig{
		{ID: "pc", Provider: "openai", APIKey: &secret, Enabled: true, Version: 7},
	}}, true)

	if err := Save(path, key, st); err != nil {
		t.Fatal(err)
	}
	raw, _ := os.ReadFile(path)
	if strings.Contains(string(raw), secret) {
		t.Fatal("provider key written to disk in plaintext")
	}
	if fi, _ := os.Stat(path); fi.Mode().Perm() != 0o600 {
		t.Fatalf("snapshot file mode = %v", fi.Mode().Perm())
	}

	got, err := Load(path, key)
	if err != nil {
		t.Fatal(err)
	}
	if got.Version != 7 || *got.Providers["pc"].APIKey != secret {
		t.Fatalf("round trip lost data: %+v", got)
	}

	if _, err := Load(path, []byte(strings.Repeat("x", 32))); err == nil {
		t.Fatal("wrong key must fail")
	}
	if _, err := Load(filepath.Join(t.TempDir(), "missing"), key); !errors.Is(err, ErrNoSnapshot) {
		t.Fatalf("missing file: %v", err)
	}
}

func TestHolderConcurrentReads(t *testing.T) {
	var h Holder
	if h.Load() != nil {
		t.Fatal("empty holder must return nil")
	}
	done := make(chan struct{})
	go func() {
		for i := 0; i < 1000; i++ {
			st := NewState()
			st.Version = int64(i)
			h.Store(st, Build(st, time.Now()))
		}
		close(done)
	}()
	for {
		select {
		case <-done:
			if h.Load().Version != 999 {
				t.Fatalf("final version %d", h.Load().Version)
			}
			return
		default:
			if s := h.Load(); s != nil && s.Version < 0 {
				t.Fatal("impossible")
			}
		}
	}
}
