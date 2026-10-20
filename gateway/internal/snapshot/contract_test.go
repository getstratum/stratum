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
	if p, _ := before.PolicyForTeam("team_marketing"); len(p.DeniedModels) != 2 {
		t.Fatalf("denied_models travels in the policy: %+v", p.DeniedModels)
	}
	if _, ok := before.KeyByHash("3ba6ea2bd037fee129f1115ad2361d4692aa55d0c3e530fa5b82622792943d1f"); !ok {
		t.Fatal("fixture: user_dev should be active before the delta")
	}
	if k, ok := before.KeyByHash("5f2b3c6a1d4e8f90a7b6c5d4e3f2a1b0c9d8e7f6a5b4c3d2e1f0a9b8c7d6e5f4"); !ok ||
		k.Provider != "openai" || k.Model != "gpt-4o-mini" {
		t.Fatalf("an agent key carries its fixed model: %+v %v", k, ok)
	}

	if k, ok := before.KeyByHash("a3c1e5b7d9f02468ace13579bdf02468ace13579bdf02468ace13579bdf02468"); !ok || !k.Delegates {
		t.Fatalf("a key that delegates says so: %+v %v", k, ok)
	}
	if m := before.Models(); len(m) != 4 || m[0].Provider != "anthropic" || m[1].Name != "GPT-4o" {
		t.Fatalf("the organization's models, sorted: %+v", m)
	}
	if team, ok := before.Person("user_writer"); !ok || team != "team_marketing" {
		t.Fatalf("people directory: %q %v", team, ok)
	}
	if _, ok := before.Person("user_former"); ok {
		t.Fatal("a revoked person must not be found")
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
	if len(snap.Models()) != 4 {
		t.Fatalf("a delta without models keeps the list: %+v", snap.Models())
	}
	if _, ok := snap.Person("user_dev"); ok {
		t.Fatal("a person revoked by a delta must stop being found")
	}
	if team, _ := snap.Person("user_writer"); team != "team_engineering" {
		t.Fatalf("a person moved to another team must follow it, got %q", team)
	}
	if len(snap.ProviderSlugs()) != len(before.ProviderSlugs())-1 {
		t.Fatalf("a deleted provider config must be dropped: before %v, after %v", before.ProviderSlugs(), snap.ProviderSlugs())
	}
}
