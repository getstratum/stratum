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
