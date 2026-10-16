// Package snapshot holds the gateway's view of its configuration: API keys,
// team policies and provider credentials. A Snapshot is immutable once built;
// the gateway swaps whole snapshots atomically and never mutates one in place.
//
// Nothing in the request path talks to the control plane, a database or Redis.
// Everything a request needs is a map lookup in the current Snapshot.
package snapshot

import (
	"bytes"
	"fmt"
	"strconv"
)

// The types in this file mirror the sync protocol v2 wire format, defined in
// api/sync/v2/sync-response.schema.json at the repository root.

// Int64 decodes a JSON number or a numeric string. The control plane is a
// Node.js service backed by PostgreSQL, and node-postgres serialises BIGINT
// columns as strings, so both shapes show up on the wire.
type Int64 int64

func (i *Int64) UnmarshalJSON(b []byte) error {
	s := string(bytes.Trim(bytes.TrimSpace(b), `"`))
	if s == "" || s == "null" {
		*i = 0
		return nil
	}
	if v, err := strconv.ParseInt(s, 10, 64); err == nil {
		*i = Int64(v)
		return nil
	}
	f, err := strconv.ParseFloat(s, 64)
	if err != nil {
		return fmt.Errorf("snapshot: %q is not an integer", s)
	}
	*i = Int64(f)
	return nil
}

// Float64 decodes a JSON number or a numeric string (PostgreSQL DECIMAL
// columns arrive as strings, e.g. "100.00").
type Float64 float64

func (f *Float64) UnmarshalJSON(b []byte) error {
	s := string(bytes.Trim(bytes.TrimSpace(b), `"`))
	if s == "" || s == "null" {
		*f = 0
		return nil
	}
	v, err := strconv.ParseFloat(s, 64)
	if err != nil {
		return fmt.Errorf("snapshot: %q is not a number", s)
	}
	*f = Float64(v)
	return nil
}

// SyncResponse is the body of GET /api/internal/sync on the control plane,
// and also the format of the standalone config file.
type SyncResponse struct {
	CurrentVersion    Int64                `json:"current_version"`
	NextSyncInSeconds Int64                `json:"next_sync_in_seconds"`
	Policies          []WirePolicy         `json:"policies"`
	APIKeys           []WireAPIKey         `json:"api_keys"`
	ProviderConfigs   []WireProviderConfig `json:"provider_configs"`
}

// WirePolicy is a team policy. One row per team: the control plane joins
// policies to teams, so a policy shared by two teams arrives twice.
type WirePolicy struct {
	ID                string   `json:"id"`
	TeamID            string   `json:"team_id"`
	Version           Int64    `json:"version"`
	AllowedModels     []string `json:"allowed_models"`
	AllowAllModels    bool     `json:"allow_all_models"`
	AllowedProviders  []string `json:"allowed_providers,omitempty"`
	MonthlyTokenQuota *Int64   `json:"monthly_token_quota"`
	MonthlyBudgetUSD  *Float64 `json:"monthly_budget_usd"`
	PIIAction         string   `json:"pii_action,omitempty"`
	DLPAction         string   `json:"dlp_action,omitempty"`
	Revoked           bool     `json:"revoked"`
}

// WireAPIKey is a developer API key. Only the SHA-256 hex digest travels;
// the raw key never leaves the control plane.
type WireAPIKey struct {
	ID      string `json:"id"`
	KeyHash string `json:"key_hash"`
	TeamID  string `json:"team_id"`
	Label   string `json:"label,omitempty"`
	Version Int64  `json:"version"`
	Revoked bool   `json:"revoked"`
	// Agent keys only: every request of the key goes to this model.
	DefaultProvider string `json:"default_provider,omitempty"`
	DefaultModel    string `json:"default_model,omitempty"`
}

// WireProviderConfig carries the customer's own provider credentials.
// APIKey is plaintext on the wire (TLS + sync token) and is encrypted
// whenever the gateway writes a snapshot to disk.
type WireProviderConfig struct {
	ID          string         `json:"id"`
	Provider    string         `json:"provider"`
	DisplayName string         `json:"display_name,omitempty"`
	APIKey      *string        `json:"api_key"`
	BaseURL     *string        `json:"base_url"`
	ExtraConfig map[string]any `json:"extra_config,omitempty"`
	Enabled     bool           `json:"enabled"`
	Version     Int64          `json:"version"`
	Revoked     bool           `json:"revoked"`
}
