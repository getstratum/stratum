package snapshot

import (
	"slices"
	"strings"
	"sync/atomic"
	"time"
)

// Key is an active developer API key.
type Key struct {
	ID     string
	TeamID string
	Label  string
	// Fixed model of an agent key: every request goes there, whatever model
	// it asks for. Empty Model means the caller chooses (within the policy).
	Provider string
	Model    string
}

// Policy is a team policy, pre-indexed for O(1) checks.
type Policy struct {
	ID                string
	TeamID            string
	AllowAllModels    bool
	AllowedModels     map[string]struct{}
	AllowedProviders  map[string]struct{} // empty = any provider
	DeniedModels      map[string]struct{} // turned off for the organization; wins over the allowlist
	MonthlyTokenQuota *int64
	MonthlyBudgetUSD  *float64
	PIIAction         string // off | log | redact | block
	DLPAction         string // off | log | redact | block
	Revoked           bool
}

// Provider is an enabled upstream provider configuration.
type Provider struct {
	ID          string
	Slug        string // openai, anthropic, groq, gemini, azure, ollama, ...
	DisplayName string
	APIKey      string
	BaseURL     string
	Extra       map[string]any
}

// Snapshot is an immutable, fully indexed view of a State.
type Snapshot struct {
	Version  int64
	SyncedAt time.Time // last time the source confirmed this configuration

	keysByHash      map[string]Key
	policiesByTeam  map[string]Policy
	providersBySlug map[string][]Provider
	activeKeys      int
}

// Build indexes a State into a Snapshot. Revoked keys and disabled or
// revoked providers are left out; revoked policies are kept so the gateway
// can answer "team disabled" instead of "no policy".
func Build(st *State, syncedAt time.Time) *Snapshot {
	s := &Snapshot{
		Version:         st.Version,
		SyncedAt:        syncedAt,
		keysByHash:      make(map[string]Key, len(st.APIKeys)),
		policiesByTeam:  make(map[string]Policy, len(st.Policies)),
		providersBySlug: map[string][]Provider{},
	}

	for _, k := range st.APIKeys {
		if k.Revoked || k.KeyHash == "" {
			continue
		}
		s.keysByHash[strings.ToLower(k.KeyHash)] = Key{ID: k.ID, TeamID: k.TeamID, Label: k.Label,
			Provider: strings.ToLower(strings.TrimSpace(k.DefaultProvider)), Model: strings.TrimSpace(k.DefaultModel)}
	}
	s.activeKeys = len(s.keysByHash)

	for teamID, p := range st.Policies {
		pol := Policy{
			ID:               p.ID,
			TeamID:           teamID,
			AllowAllModels:   p.AllowAllModels,
			AllowedModels:    toSet(p.AllowedModels),
			AllowedProviders: toSet(p.AllowedProviders),
			DeniedModels:     toSet(p.DeniedModels),
			PIIAction:        normalizeAction(p.PIIAction),
			DLPAction:        normalizeAction(p.DLPAction),
			Revoked:          p.Revoked,
		}
		if p.MonthlyTokenQuota != nil {
			v := int64(*p.MonthlyTokenQuota)
			pol.MonthlyTokenQuota = &v
		}
		if p.MonthlyBudgetUSD != nil {
			v := float64(*p.MonthlyBudgetUSD)
			pol.MonthlyBudgetUSD = &v
		}
		s.policiesByTeam[teamID] = pol
	}

	for _, pc := range st.Providers {
		if !pc.Enabled || pc.Revoked {
			continue
		}
		p := Provider{
			ID:          pc.ID,
			Slug:        strings.ToLower(pc.Provider),
			DisplayName: pc.DisplayName,
			Extra:       pc.ExtraConfig,
		}
		if pc.APIKey != nil {
			p.APIKey = *pc.APIKey
		}
		if pc.BaseURL != nil {
			p.BaseURL = strings.TrimRight(*pc.BaseURL, "/")
		}
		s.providersBySlug[p.Slug] = append(s.providersBySlug[p.Slug], p)
	}
	// Deterministic choice when several configs exist for one provider.
	for slug := range s.providersBySlug {
		slices.SortFunc(s.providersBySlug[slug], func(a, b Provider) int { return strings.Compare(a.ID, b.ID) })
	}
	return s
}

// KeyByHash looks up an active API key by its SHA-256 hex digest.
func (s *Snapshot) KeyByHash(hash string) (Key, bool) {
	k, ok := s.keysByHash[hash]
	return k, ok
}

// PolicyForTeam returns the team's policy.
func (s *Snapshot) PolicyForTeam(teamID string) (Policy, bool) {
	p, ok := s.policiesByTeam[teamID]
	return p, ok
}

// Provider returns the preferred enabled configuration for a provider slug.
func (s *Snapshot) Provider(slug string) (Provider, bool) {
	list := s.providersBySlug[strings.ToLower(slug)]
	if len(list) == 0 {
		return Provider{}, false
	}
	return list[0], true
}

// ProviderSlugs lists every provider with at least one enabled config.
func (s *Snapshot) ProviderSlugs() []string {
	out := make([]string, 0, len(s.providersBySlug))
	for slug := range s.providersBySlug {
		out = append(out, slug)
	}
	slices.Sort(out)
	return out
}

// ActiveKeys is the number of usable API keys.
func (s *Snapshot) ActiveKeys() int { return s.activeKeys }

// Age is how long ago the source last confirmed this configuration.
func (s *Snapshot) Age(now time.Time) time.Duration { return now.Sub(s.SyncedAt) }

func toSet(list []string) map[string]struct{} {
	m := make(map[string]struct{}, len(list))
	for _, v := range list {
		if v = strings.TrimSpace(v); v != "" {
			m[v] = struct{}{}
		}
	}
	return m
}

func normalizeAction(a string) string {
	switch a = strings.ToLower(strings.TrimSpace(a)); a {
	case "log", "redact", "block":
		return a
	default:
		return "off"
	}
}

// Holder publishes the current State and Snapshot to concurrent readers.
// There is a single writer (the config source); readers never block.
type Holder struct {
	cur atomic.Pointer[entry]
}

type entry struct {
	state *State
	snap  *Snapshot
}

// Load returns the current snapshot, or nil before the first one exists.
func (h *Holder) Load() *Snapshot {
	if e := h.cur.Load(); e != nil {
		return e.snap
	}
	return nil
}

// State returns the state behind the current snapshot, or nil.
func (h *Holder) State() *State {
	if e := h.cur.Load(); e != nil {
		return e.state
	}
	return nil
}

// Store atomically replaces the current configuration.
func (h *Holder) Store(st *State, snap *Snapshot) {
	h.cur.Store(&entry{state: st, snap: snap})
}

// Replace stores st only if the current state is still old (nil = none
// yet). It reports whether it did. A fallback source uses it so that it can
// never overwrite a configuration the primary source stored meanwhile.
func (h *Holder) Replace(old, st *State, snap *Snapshot) bool {
	cur := h.cur.Load()
	if (cur == nil && old != nil) || (cur != nil && cur.state != old) {
		return false
	}
	return h.cur.CompareAndSwap(cur, &entry{state: st, snap: snap})
}
