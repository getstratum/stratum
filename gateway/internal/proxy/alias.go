package proxy

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"

	"github.com/getstratum/stratum/gateway/internal/policy"
	"github.com/getstratum/stratum/gateway/internal/provider"
	"github.com/getstratum/stratum/gateway/internal/snapshot"
)

// AliasPrefix names a model alias in a request: "model": "stratum/<name>"
// (ADR-0015). It is never a provider.
const AliasPrefix = "stratum"

// route is one place a request can go: a provider configuration, a model
// and the body prepared for them.
type route struct {
	slug, model string
	prov        snapshot.Provider
	base        string
	kind        provider.Kind
	path        string // the upstream path
	final       []byte // the body for this route (prepare)
}

// aliasName is the alias a request names: in its model, or as the fixed
// model of its agent (provider "stratum"). Never on /proxy/{provider}/.
func aliasName(explicit bool, key snapshot.Key, model string) string {
	if explicit {
		return ""
	}
	if key.Model != "" {
		if key.Provider == AliasPrefix {
			return strings.ToLower(key.Model)
		}
		return "" // an agent's fixed model wins over what the request asks
	}
	if pfx, rest, cut := strings.Cut(model, "/"); cut && strings.EqualFold(pfx, AliasPrefix) {
		return strings.ToLower(rest)
	}
	return ""
}

// aliasRoutes are the alias's targets this request may use, in order: the
// ones the team's policy allows, of configured providers, in the request's
// API format. With none, the reason the first one was left out.
func aliasRoutes(snap *snapshot.Snapshot, pol snapshot.Policy, polFound bool, name, upstreamPath string, anthropicFormat bool) ([]route, *policy.Violation) {
	targets, ok := snap.Alias(name)
	if !ok {
		return nil, &policy.Violation{Status: http.StatusBadRequest, Code: "unknown_alias",
			Message: "model alias " + strconv.Quote(name) + " is not defined for this organization; GET /v1/models lists the ones this key can use"}
	}
	var out []route
	var first *policy.Violation
	note := func(v *policy.Violation) {
		if first == nil {
			first = v
		}
	}
	for _, t := range targets {
		kind := provider.KindOf(t.Provider)
		if (kind == provider.KindAnthropic) != anthropicFormat {
			note(&policy.Violation{Status: http.StatusBadRequest, Code: "alias_format_mismatch",
				Message: "model alias " + strconv.Quote(name) + " goes to models that take a different API format than this request"})
			continue
		}
		if v := policy.Check(pol, polFound, t.Provider, t.Model); v != nil {
			note(v)
			continue
		}
		prov, ok := snap.Provider(t.Provider)
		if !ok {
			note(&policy.Violation{Status: http.StatusBadRequest, Code: "provider_not_configured",
				Message: "provider " + t.Provider + " is not configured for this organization"})
			continue
		}
		base, ok := provider.BaseURL(prov)
		if !ok {
			note(&policy.Violation{Status: http.StatusBadGateway, Code: "provider_misconfigured",
				Message: "provider " + t.Provider + " has no base_url"})
			continue
		}
		out = append(out, route{slug: t.Provider, model: t.Model, prov: prov, base: base, kind: kind, path: upstreamPath})
	}
	if len(out) == 0 {
		return nil, first
	}
	return out, nil
}

// prepare makes rt's body: its model, usage in streams, the policy's
// maximum output tokens and the team's instructions in the fields its API
// uses, then the policy's PII and DLP rules. body is the request as
// decoded; nil decodes it again from rec, for a later route.
func (h *Handler) prepare(w http.ResponseWriter, rec *record, body map[string]any, rt *route, pol snapshot.Policy, polFound bool) *policy.Violation {
	if body == nil {
		b, err := decodeObject(rec.raw)
		if err != nil {
			return &policy.Violation{Status: http.StatusInternalServerError, Code: "internal", Message: "could not decode request"}
		}
		body = b
	}
	if rt.model != "" {
		body["model"] = rt.model
	}
	if rec.stream && rt.kind != provider.KindAnthropic {
		if _, set := body["stream_options"]; !set {
			// Ask OpenAI-compatible providers to report usage in the last chunk.
			body["stream_options"] = map[string]any{"include_usage": true}
		}
	}
	// The policy's maximum output tokens per request (from 0.3).
	if polFound && pol.MaxTokensPerRequest != nil && *pol.MaxTokensPerRequest > 0 {
		if capOutputTokens(body, rt.path, rt.slug, rt.kind, *pol.MaxTokensPerRequest) {
			w.Header().Set("X-Stratum-Max-Tokens", strconv.FormatInt(*pol.MaxTokensPerRequest, 10))
		}
	}
	// The team's instructions, only for a person (see instructions.go).
	if rec.userID != "" && polFound && pol.PeopleInstructions != "" {
		if addInstructions(body, rt.path, rt.kind, pol.PeopleInstructions) {
			w.Header().Set("X-Stratum-Instructions", instructionsID(pol.PeopleInstructions))
		}
	}
	final, err := json.Marshal(body)
	if err != nil {
		return &policy.Violation{Status: http.StatusInternalServerError, Code: "internal", Message: "could not encode request"}
	}
	// ── PII / DLP ───────────────────────────────────────────────────────
	if h.PIIEnabled && polFound {
		var found []string
		var v *policy.Violation
		if final, found, v = applyContentRules(final, pol); v != nil {
			rec.piiTypes = found
			return v
		}
		if rec.piiTypes == nil {
			rec.piiTypes = found
		}
	}
	rt.final = final
	return nil
}

// fallsOver: what the alias's next model is tried after (ADR-0015). The
// provider's breaker is open, the request could not reach it, or it said
// "not now" or failed, after its own retries. Never when the provider may
// have run the request without answering (a timeout, a connection that
// broke after the request was written): a generation costs money, as in
// ADR-0010. Nor when the client left, nor on answers the request itself may
// cause.
func fallsOver(res *http.Response, err error) bool {
	if err != nil {
		var paused *breakerOpenError
		return errors.As(err, &paused) || (!errors.Is(err, context.Canceled) && notSent(err))
	}
	switch res.StatusCode {
	case http.StatusTooManyRequests, http.StatusInternalServerError, http.StatusBadGateway,
		http.StatusServiceUnavailable, http.StatusGatewayTimeout, 529: // 529: Anthropic overloaded
		return true
	}
	return false
}
