package syncer

import (
	"encoding/json"
	"fmt"
	"os"
	"strings"

	"github.com/getstratum/stratum/gateway/internal/snapshot"
)

// LoadStatic reads a standalone configuration file. The format is the same
// as a control plane sync response, so configurations move freely between
// the two modes. Provider keys may reference the environment instead of
// being written in the file: "api_key": "env:OPENAI_API_KEY".
func LoadStatic(path string, getenv func(string) string) (*snapshot.State, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var resp snapshot.SyncResponse
	dec := json.NewDecoder(strings.NewReader(string(raw)))
	dec.DisallowUnknownFields() // typos in a hand-written file should fail loudly
	if err := dec.Decode(&resp); err != nil {
		return nil, fmt.Errorf("%s: %w", path, err)
	}

	for i, pc := range resp.ProviderConfigs {
		if pc.APIKey == nil {
			continue
		}
		if name, ok := strings.CutPrefix(*pc.APIKey, "env:"); ok {
			v := getenv(name)
			if v == "" {
				return nil, fmt.Errorf("%s: provider %q references env var %s, which is empty", path, pc.ID, name)
			}
			resp.ProviderConfigs[i].APIKey = &v
		}
	}
	for _, k := range resp.APIKeys {
		if len(k.KeyHash) != 64 && !k.Revoked {
			return nil, fmt.Errorf("%s: api key %q: key_hash must be a SHA-256 hex digest (use `stratum-gateway hash-key`)", path, k.ID)
		}
	}
	return (*snapshot.State)(nil).Apply(&resp, true)
}
