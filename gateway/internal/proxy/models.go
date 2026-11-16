package proxy

import (
	"encoding/json"
	"net/http"
	"slices"
	"strings"
	"time"

	"github.com/getstratum/stratum/gateway/internal/policy"
	"github.com/getstratum/stratum/gateway/internal/snapshot"
)

// Models answers GET /v1/models in the OpenAI format with the models the
// caller may use: the organization's models (from the sync) that the
// caller's policy allows, as a request would be checked. The caller is the
// key's team, or the person a delegating key names in X-Stratum-User. An
// agent with a fixed model sees only that model.
//
// Each id is "provider/model", which /v1/chat/completions accepts as is, so
// a client can send back whatever it picked from the list.
//
// Without a list from the control plane (before 0.4, or a standalone
// config file), the policy's own "provider/model" entries are listed.
//
// Model aliases come first, as "stratum/<name>" (ADR-0015): each one with
// at least one model the caller may use.
//
// Each model says its kind when the control plane sent one (chat,
// embedding, image, transcription, speech, moderation, other), so a client
// can offer chat models in a chat; an alias, the kind of its first model.
// The policy's default model or route says "default": true.
func (h *Handler) Models(w http.ResponseWriter, r *http.Request) {
	rec := &record{start: time.Now()}
	defer h.finishModels(rec)

	snap := h.Holder.Load()
	if snap == nil {
		h.fail(w, rec, &policy.Violation{Status: http.StatusServiceUnavailable, Code: "not_ready", Message: "gateway has no configuration yet"})
		return
	}
	key, teamID, _, v := h.caller(r, snap)
	if v != nil {
		h.fail(w, rec, v)
		return
	}
	pol, found := snap.PolicyForTeam(teamID)
	if v := policyUsable(pol, found); v != nil {
		h.fail(w, rec, v)
		return
	}

	type model struct {
		ID      string `json:"id"`
		Object  string `json:"object"`
		Created int64  `json:"created"`
		OwnedBy string `json:"owned_by"`
		Name    string `json:"name,omitempty"`
		Kind    string `json:"kind,omitempty"`
		// Capabilities: "tools", "vision" (control planes 0.8 and later).
		Capabilities []string `json:"capabilities,omitempty"`
		Default      bool     `json:"default,omitempty"`
	}
	list := snap.Models()
	out := []model{}
	add := func(provider, id string, m snapshot.WireModel) {
		if _, configured := snap.Provider(provider); !configured {
			return
		}
		if policy.Check(pol, found, provider, id) != nil {
			return
		}
		out = append(out, model{ID: provider + "/" + id, Object: "model", OwnedBy: provider, Name: m.Name, Kind: m.Kind, Capabilities: m.Capabilities})
	}

	// A route: the kind of its first model, and only what every model it
	// may go to can do (a request with an image must not fall back to a
	// model that cannot read it).
	addAlias := func(name string) {
		targets, _ := snap.Alias(name)
		var caps []string
		usable := 0
		for _, t := range targets {
			if _, configured := snap.Provider(t.Provider); !configured || policy.Check(pol, found, t.Provider, t.Model) != nil {
				continue
			}
			c := modelIn(list, t.Provider, t.Model).Capabilities
			if usable == 0 {
				caps = slices.Clone(c)
			} else {
				caps = slices.DeleteFunc(caps, func(x string) bool { return !slices.Contains(c, x) })
			}
			usable++
		}
		if usable > 0 {
			first := modelIn(list, targets[0].Provider, targets[0].Model)
			out = append(out, model{ID: AliasPrefix + "/" + name, Object: "model", OwnedBy: AliasPrefix, Kind: first.Kind, Capabilities: caps})
		}
	}

	switch {
	case key.Model != "" && key.Provider == AliasPrefix:
		// An agent whose fixed model is an alias.
		addAlias(strings.ToLower(key.Model))
	case key.Model != "":
		// An agent with a fixed model: every request goes there.
		prov := key.Provider
		if prov == "" {
			prov = pickOnly(snap, pol)
		}
		if prov != "" {
			add(prov, key.Model, modelIn(list, prov, key.Model))
		}
	case list != nil:
		for _, name := range snap.AliasNames() {
			addAlias(name)
		}
		for _, m := range list {
			add(m.Provider, m.ID, m)
		}
	default:
		for _, name := range snap.AliasNames() {
			addAlias(name)
		}
		n := len(out)
		for name := range pol.AllowedModels {
			if prov, id, ok := strings.Cut(name, "/"); ok {
				add(strings.ToLower(prov), id, snapshot.WireModel{})
			}
		}
		slices.SortFunc(out[n:], func(a, b model) int { return strings.Compare(a.ID, b.ID) })
	}

	// The policy's default, a model or a route, when the caller has it.
	if pol.DefaultModel != "" && key.Model == "" {
		for i := range out {
			if strings.EqualFold(out[i].ID, pol.DefaultModel) {
				out[i].Default = true
				break
			}
		}
	}

	rec.status, rec.reason = http.StatusOK, "ok"
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"object": "list", "data": out})
}

// policyUsable refuses a team without a policy, or disabled, the same way a
// request would be refused.
func policyUsable(pol snapshot.Policy, found bool) *policy.Violation {
	if !found {
		return &policy.Violation{Status: http.StatusForbidden, Code: "no_policy", Message: "no policy is assigned to this team"}
	}
	if pol.Revoked {
		return &policy.Violation{Status: http.StatusForbidden, Code: "team_disabled", Message: "this team is disabled"}
	}
	return nil
}

// pickOnly is the provider a request without one would go to, when there
// is a single candidate (see pickProvider).
func pickOnly(snap *snapshot.Snapshot, pol snapshot.Policy) string {
	if len(pol.AllowedProviders) == 1 {
		for p := range pol.AllowedProviders {
			return strings.ToLower(p)
		}
	}
	if slugs := snap.ProviderSlugs(); len(slugs) == 1 {
		return slugs[0]
	}
	return ""
}

// modelIn is what the control plane sent about a model: its name, kind
// and capabilities; empty when it does not list the model.
func modelIn(list []snapshot.WireModel, provider, id string) snapshot.WireModel {
	for _, m := range list {
		if m.Provider == provider && m.ID == id {
			return m
		}
	}
	return snapshot.WireModel{}
}

// finishModels counts the listing like any other answer, without a usage
// record: no provider was called and nothing was consumed.
func (h *Handler) finishModels(rec *record) {
	h.Metrics.Request(rec.status, "", rec.reason)
}
