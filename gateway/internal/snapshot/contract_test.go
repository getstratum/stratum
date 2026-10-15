package snapshot

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// TestContractExamples decodes every example in api/sync/v2/examples. CI
// also validates the same files against the JSON Schema, so the schema, the
// examples and the gateway decoder cannot drift apart silently.
func TestContractExamples(t *testing.T) {
	files, _ := filepath.Glob("../../../api/sync/v2/examples/*.json")
	if len(files) == 0 {
		t.Fatal("no contract examples found")
	}
	for _, f := range files {
		t.Run(filepath.Base(f), func(t *testing.T) {
			raw, err := os.ReadFile(f)
			if err != nil {
				t.Fatal(err)
			}
			var resp SyncResponse
			if err := json.Unmarshal(raw, &resp); err != nil {
				t.Fatalf("gateway cannot decode contract example: %v", err)
			}
			st, err := (*State)(nil).Apply(&resp, true)
			if err != nil {
				t.Fatal(err)
			}
			snap := Build(st, time.Now())
			if snap.Version != int64(resp.CurrentVersion) {
				t.Fatalf("version %d != %d", snap.Version, resp.CurrentVersion)
			}
		})
	}
}

// TestRevocationsDelta applies the revocations example as a delta on top of
// the full example: every way a key, a team or a provider stops working
// must take effect without waiting for a full resync.
func TestRevocationsDelta(t *testing.T) {
	load := func(name string) *SyncResponse {
		raw, err := os.ReadFile(filepath.Join("../../../api/sync/v2/examples", name))
		if err != nil {
			t.Fatal(err)
		}
		var r SyncResponse
		if err := json.Unmarshal(raw, &r); err != nil {
			t.Fatal(err)
		}
		return &r
	}
	full, err := (*State)(nil).Apply(load("full-sync.json"), true)
	if err != nil {
		t.Fatal(err)
	}
	before := Build(full, time.Now())
	if _, ok := before.KeyByHash("3ba6ea2bd037fee129f1115ad2361d4692aa55d0c3e530fa5b82622792943d1f"); !ok {
		t.Fatal("fixture: user_dev should be active before the delta")
	}

	st, err := full.Apply(load("delta-revocations.json"), false)
	if err != nil {
		t.Fatal(err)
	}
	snap := Build(st, time.Now())
	if _, ok := snap.KeyByHash("3ba6ea2bd037fee129f1115ad2361d4692aa55d0c3e530fa5b82622792943d1f"); ok {
		t.Fatal("a removed key (empty key_hash, revoked) must stop working")
	}
	if p, ok := snap.PolicyForTeam("team_marketing"); !ok || !p.Revoked {
		t.Fatalf("a team left without a policy must be disabled, got %+v %v", p, ok)
	}
	if p, _ := snap.PolicyForTeam("team_engineering"); p.ID != "pol_restricted" {
		t.Fatalf("a team moved to another policy must use it, got %q", p.ID)
	}
	if len(snap.ProviderSlugs()) != len(before.ProviderSlugs())-1 {
		t.Fatalf("a deleted provider config must be dropped: before %v, after %v", before.ProviderSlugs(), snap.ProviderSlugs())
	}
}
