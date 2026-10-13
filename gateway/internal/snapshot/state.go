package snapshot

import (
	"errors"
	"fmt"
	"maps"
)

// State is the accumulated configuration as received from the source
// (control plane or config file), keyed for idempotent upserts. It is what
// gets persisted to disk. Revoked entries are kept as tombstones so a later
// delta cannot resurrect them out of order.
type State struct {
	Version   int64                         `json:"version"`
	Policies  map[string]WirePolicy         `json:"policies"`  // by team_id
	APIKeys   map[string]WireAPIKey         `json:"api_keys"`  // by id
	Providers map[string]WireProviderConfig `json:"providers"` // by id
}

// NewState returns an empty state.
func NewState() *State {
	return &State{
		Policies:  map[string]WirePolicy{},
		APIKeys:   map[string]WireAPIKey{},
		Providers: map[string]WireProviderConfig{},
	}
}

func (s *State) clone() *State {
	return &State{
		Version:   s.Version,
		Policies:  maps.Clone(s.Policies),
		APIKeys:   maps.Clone(s.APIKeys),
		Providers: maps.Clone(s.Providers),
	}
}

// Apply returns a new State with resp applied on top of s. When full is
// true the response is treated as the complete configuration and replaces
// s entirely; otherwise it is a delta and entries are upserted, keeping
// whichever copy has the higher version.
//
// s is never modified.
func (s *State) Apply(resp *SyncResponse, full bool) (*State, error) {
	var next *State
	if full || s == nil {
		next = NewState()
	} else {
		next = s.clone()
	}

	for _, p := range resp.Policies {
		if p.TeamID == "" {
			return nil, fmt.Errorf("snapshot: policy %q has no team_id", p.ID)
		}
		if cur, ok := next.Policies[p.TeamID]; ok && int64(cur.Version) > int64(p.Version) {
			continue
		}
		next.Policies[p.TeamID] = p
	}
	for _, k := range resp.APIKeys {
		if k.ID == "" || (k.KeyHash == "" && !k.Revoked) {
			return nil, fmt.Errorf("snapshot: api key %q is missing id or key_hash", k.ID)
		}
		if cur, ok := next.APIKeys[k.ID]; ok && int64(cur.Version) > int64(k.Version) {
			continue
		}
		next.APIKeys[k.ID] = k
	}
	for _, pc := range resp.ProviderConfigs {
		if pc.ID == "" || pc.Provider == "" {
			return nil, fmt.Errorf("snapshot: provider config %q is missing id or provider", pc.ID)
		}
		if cur, ok := next.Providers[pc.ID]; ok && int64(cur.Version) > int64(pc.Version) {
			continue
		}
		next.Providers[pc.ID] = pc
	}

	next.Version = int64(resp.CurrentVersion)
	if !full && s != nil && s.Version > next.Version {
		next.Version = s.Version
	}
	return next, nil
}

// ErrSuspiciousChange is returned by Guard when a full resync would make a
// large share of the active configuration disappear without explicit
// revocations. That pattern points at a control plane bug or a database
// restored from an old backup, not at an operator's intent.
var ErrSuspiciousChange = errors.New("snapshot: suspicious full resync rejected")

// Guard compares the active configuration before and after a full resync.
//
// Keys that are explicitly revoked in next pass freely: a mass revocation
// during an incident must never be blocked. What Guard catches is active
// keys that silently vanish. It also rejects a resync that would leave the
// gateway with no enabled providers when it previously had some.
//
// maxDropRatio is the largest tolerated share of vanished keys (0.5 = 50%).
// Below minKeys active keys the ratio check is skipped, since small
// installations legitimately churn by large percentages.
func Guard(prev, next *State, maxDropRatio float64, minKeys int) error {
	if prev == nil || maxDropRatio >= 1 {
		return nil
	}

	active, vanished := 0, 0
	for id, k := range prev.APIKeys {
		if k.Revoked {
			continue
		}
		active++
		if _, ok := next.APIKeys[id]; !ok {
			vanished++
		}
	}
	if active >= minKeys && float64(vanished) > maxDropRatio*float64(active) {
		return fmt.Errorf("%w: %d of %d active api keys would disappear without a revocation",
			ErrSuspiciousChange, vanished, active)
	}

	if countEnabledProviders(prev) > 0 && countEnabledProviders(next) == 0 {
		return fmt.Errorf("%w: every enabled provider would disappear", ErrSuspiciousChange)
	}
	return nil
}

func countEnabledProviders(s *State) int {
	n := 0
	for _, p := range s.Providers {
		if p.Enabled && !p.Revoked {
			n++
		}
	}
	return n
}
