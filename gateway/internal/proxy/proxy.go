// Package proxy is the request hot path: authenticate, route, enforce
// policy, scan for PII, forward to the provider and stream the answer back.
//
// Everything here reads from the in-memory snapshot. The only network call
// is the one to the LLM provider.
package proxy

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/http"
	"strings"
	"time"

	"github.com/getstratum/stratum/gateway/internal/auth"
	"github.com/getstratum/stratum/gateway/internal/metrics"
	"github.com/getstratum/stratum/gateway/internal/pii"
	"github.com/getstratum/stratum/gateway/internal/policy"
	"github.com/getstratum/stratum/gateway/internal/provider"
	"github.com/getstratum/stratum/gateway/internal/quota"
	"github.com/getstratum/stratum/gateway/internal/snapshot"
)

type Handler struct {
	Holder            *snapshot.Holder
	Quota             *quota.Local
	Metrics           *metrics.Metrics
	Log               *slog.Logger
	Client            *http.Client
	MaxRequestBytes   int64
	StreamIdleTimeout time.Duration
	PIIEnabled        bool
	UserAgent         string
	RequestID         func(context.Context) string
}

// NewTransport returns the upstream transport. There is deliberately no
// overall request timeout: a streamed completion can legitimately run for
// many minutes. Instead each phase has its own bound, and the stream idle
// watchdog in pump catches a provider that goes silent mid-stream.
func NewTransport(headerTimeout time.Duration) *http.Transport {
	return &http.Transport{
		Proxy:                 http.ProxyFromEnvironment,
		DialContext:           (&net.Dialer{Timeout: 5 * time.Second, KeepAlive: 30 * time.Second}).DialContext,
		TLSHandshakeTimeout:   5 * time.Second,
		ResponseHeaderTimeout: headerTimeout,
		ExpectContinueTimeout: time.Second,
		IdleConnTimeout:       90 * time.Second,
		MaxIdleConns:          512,
		MaxIdleConnsPerHost:   128,
		ForceAttemptHTTP2:     true,
	}
}

// record collects what we log and count for each request.
type record struct {
	start      time.Time
	status     int
	reason     string
	teamID     string
	keyID      string
	provider   string
	model      string
	stream     bool
	upstreamMs int64
	usage      Usage
	piiTypes   []string
}

func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	rec := &record{start: time.Now()}
	defer h.finish(r, rec)

	if r.Method != http.MethodPost {
		h.fail(w, rec, &policy.Violation{Status: http.StatusMethodNotAllowed, Code: "method_not_allowed", Message: "only POST is supported"})
		return
	}
	snap := h.Holder.Load()
	if snap == nil {
		h.fail(w, rec, &policy.Violation{Status: http.StatusServiceUnavailable, Code: "not_ready", Message: "gateway has no configuration yet"})
		return
	}

	// ── Authenticate ────────────────────────────────────────────────────
	key, err := auth.Resolve(snap, auth.ExtractKey(r))
	if err != nil {
		code := "invalid_api_key"
		if errors.Is(err, auth.ErrMissingKey) {
			code = "missing_api_key"
		}
		h.fail(w, rec, &policy.Violation{Status: http.StatusUnauthorized, Code: code, Message: err.Error()})
		return
	}
	rec.teamID, rec.keyID = key.TeamID, key.ID

	// ── Route ───────────────────────────────────────────────────────────
	slug, upstreamPath, explicit, ok := splitRoute(r.URL.Path)
	if !ok {
		h.fail(w, rec, &policy.Violation{Status: http.StatusNotFound, Code: "not_found", Message: "use /v1/... or /proxy/{provider}/..."})
		return
	}

	// ── Body ────────────────────────────────────────────────────────────
	raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, h.MaxRequestBytes))
	if err != nil {
		var tooBig *http.MaxBytesError
		if errors.As(err, &tooBig) {
			h.fail(w, rec, &policy.Violation{Status: http.StatusRequestEntityTooLarge, Code: "request_too_large", Message: "request body is too large"})
		} else {
			h.fail(w, rec, &policy.Violation{Status: http.StatusBadRequest, Code: "invalid_body", Message: "could not read request body"})
		}
		return
	}
	body, err := decodeObject(raw)
	if err != nil {
		h.fail(w, rec, &policy.Violation{Status: http.StatusBadRequest, Code: "invalid_json", Message: "request body must be a JSON object"})
		return
	}
	model, _ := body["model"].(string)
	pol, polFound := snap.PolicyForTeam(key.TeamID)

	if explicit {
		slug = strings.ToLower(slug)
		if pfx, rest, cut := strings.Cut(model, "/"); cut && strings.EqualFold(pfx, slug) {
			model = rest
		}
	} else if slug, model, ok = pickProvider(snap, pol, polFound, model); !ok {
		h.fail(w, rec, &policy.Violation{Status: http.StatusBadRequest, Code: "ambiguous_provider",
			Message: `cannot infer the provider; send "model": "provider/model" or call /proxy/{provider}/...`})
		return
	}
	rec.provider, rec.model = slug, model
	if model != "" {
		body["model"] = model
	}

	// ── Policy and quota ────────────────────────────────────────────────
	if v := policy.Check(pol, polFound, slug, model); v != nil {
		h.fail(w, rec, v)
		return
	}
	if v := h.Quota.Check(key.TeamID, pol); v != nil {
		h.fail(w, rec, v)
		return
	}

	prov, ok := snap.Provider(slug)
	if !ok {
		h.fail(w, rec, &policy.Violation{Status: http.StatusBadRequest, Code: "provider_not_configured",
			Message: "provider " + slug + " is not configured for this organization"})
		return
	}
	base, ok := provider.BaseURL(prov)
	if !ok {
		h.fail(w, rec, &policy.Violation{Status: http.StatusBadGateway, Code: "provider_misconfigured",
			Message: "provider " + slug + " has no base_url"})
		return
	}
	kind := provider.KindOf(slug)

	rec.stream, _ = body["stream"].(bool)
	if rec.stream && kind != provider.KindAnthropic {
		if _, set := body["stream_options"]; !set {
			// Ask OpenAI-compatible providers to report usage in the last chunk.
			body["stream_options"] = map[string]any{"include_usage": true}
		}
	}
	final, err := json.Marshal(body)
	if err != nil {
		h.fail(w, rec, &policy.Violation{Status: http.StatusInternalServerError, Code: "internal", Message: "could not encode request"})
		return
	}

	// ── PII / DLP ───────────────────────────────────────────────────────
	if h.PIIEnabled && polFound {
		var v *policy.Violation
		final, rec.piiTypes, v = applyContentRules(final, pol)
		if v != nil {
			h.fail(w, rec, v)
			return
		}
	}

	// ── Forward ─────────────────────────────────────────────────────────
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	ureq, err := http.NewRequestWithContext(ctx, http.MethodPost,
		provider.TargetURL(prov, base, upstreamPath, r.URL.RawQuery), bytes.NewReader(final))
	if err != nil {
		h.fail(w, rec, &policy.Violation{Status: http.StatusInternalServerError, Code: "internal", Message: "could not build upstream request"})
		return
	}
	ureq.Header.Set("Content-Type", "application/json")
	for _, name := range []string{"Accept", "Anthropic-Version", "Anthropic-Beta", "OpenAI-Beta"} {
		if v := r.Header.Get(name); v != "" {
			ureq.Header.Set(name, v)
		}
	}
	if h.UserAgent != "" {
		ureq.Header.Set("User-Agent", h.UserAgent)
	}
	provider.SetAuth(ureq.Header, prov)

	upStart := time.Now()
	res, err := h.Client.Do(ureq)
	rec.upstreamMs = time.Since(upStart).Milliseconds()
	if err != nil {
		switch {
		case r.Context().Err() != nil:
			rec.status, rec.reason = 499, "client_closed"
		case isTimeout(err):
			h.fail(w, rec, &policy.Violation{Status: http.StatusGatewayTimeout, Code: "upstream_timeout", Message: "the AI provider did not answer in time"})
		default:
			h.fail(w, rec, &policy.Violation{Status: http.StatusBadGateway, Code: "upstream_unreachable", Message: "could not reach the AI provider"})
		}
		return
	}
	defer res.Body.Close()

	copyResponseHeaders(w.Header(), res.Header)
	w.WriteHeader(res.StatusCode)
	rec.status, rec.reason = res.StatusCode, "ok"
	if res.StatusCode >= 400 {
		rec.reason = "upstream_status"
	}

	usage, perr := pump(w, res.Body, cancel, h.StreamIdleTimeout, rec.stream && res.StatusCode == http.StatusOK, kind)
	rec.usage = usage
	switch {
	case perr == nil:
	case errors.Is(perr, errIdle):
		rec.reason = "stream_idle_timeout"
	case r.Context().Err() != nil:
		rec.reason = "client_closed"
	default:
		rec.reason = "upstream_aborted"
	}

	if total := usage.Input + usage.Output; total > 0 {
		h.Quota.Add(key.TeamID, total)
		h.Metrics.UpstreamTokens.Add(total)
	}
}

// splitRoute maps a public path to (provider, upstream path).
//
//	/proxy/{provider}/{path} → explicit provider
//	/v1/{path}               → provider inferred from the body
func splitRoute(p string) (slug, upstream string, explicit, ok bool) {
	if rest, found := strings.CutPrefix(p, "/proxy/"); found {
		slug, upstream, ok = strings.Cut(rest, "/")
		return slug, upstream, true, ok && slug != "" && upstream != ""
	}
	if strings.HasPrefix(p, "/v1/") && len(p) > len("/v1/") {
		return "", strings.TrimPrefix(p, "/"), false, true
	}
	return "", "", false, false
}

// pickProvider infers the provider for /v1 requests:
//  1. "provider/model" when the prefix is a configured provider
//     (so "meta-llama/Llama-3" on a single provider still works),
//  2. the only provider the team's policy allows,
//  3. the only provider configured at all.
func pickProvider(snap *snapshot.Snapshot, pol snapshot.Policy, found bool, model string) (string, string, bool) {
	if pfx, rest, cut := strings.Cut(model, "/"); cut {
		if _, ok := snap.Provider(strings.ToLower(pfx)); ok {
			return strings.ToLower(pfx), rest, true
		}
	}
	if found && len(pol.AllowedProviders) == 1 {
		for p := range pol.AllowedProviders {
			return strings.ToLower(p), model, true
		}
	}
	if slugs := snap.ProviderSlugs(); len(slugs) == 1 {
		return slugs[0], model, true
	}
	return "", model, false
}

// applyContentRules runs the policy's PII and DLP actions on the outgoing
// body. Blocking rules run first, then redaction, then log-only scans.
func applyContentRules(body []byte, pol snapshot.Policy) ([]byte, []string, *policy.Violation) {
	byAction := map[string][]string{}
	byAction[pol.PIIAction] = append(byAction[pol.PIIAction], pii.PersonalTypes...)
	byAction[pol.DLPAction] = append(byAction[pol.DLPAction], pii.SecretTypes...)

	var found []string
	if types := byAction["block"]; len(types) > 0 {
		res, err := pii.ScanJSON(body, types)
		if err == nil && res.Flagged {
			return body, res.Types, &policy.Violation{Status: http.StatusForbidden, Code: "sensitive_data_detected",
				Message: "request blocked: sensitive data detected (" + strings.Join(res.Types, ", ") + ")"}
		}
	}
	if types := byAction["redact"]; len(types) > 0 {
		if out, res, err := pii.RedactJSON(body, types); err == nil {
			body = out
			found = append(found, res.Types...)
		}
	}
	if types := byAction["log"]; len(types) > 0 {
		if res, err := pii.ScanJSON(body, types); err == nil {
			found = append(found, res.Types...)
		}
	}
	return body, found, nil
}

func decodeObject(raw []byte) (map[string]any, error) {
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber() // keep integers exact when we re-encode
	var body map[string]any
	if err := dec.Decode(&body); err != nil {
		return nil, err
	}
	if body == nil {
		return nil, errors.New("not an object")
	}
	return body, nil
}

var hopByHop = map[string]bool{
	"Connection": true, "Keep-Alive": true, "Proxy-Authenticate": true, "Proxy-Authorization": true,
	"Te": true, "Trailer": true, "Transfer-Encoding": true, "Upgrade": true,
	"Content-Length": true, "Set-Cookie": true,
}

func copyResponseHeaders(dst, src http.Header) {
	for k, vs := range src {
		if hopByHop[http.CanonicalHeaderKey(k)] {
			continue
		}
		for _, v := range vs {
			dst.Add(k, v)
		}
	}
}

func isTimeout(err error) bool {
	var ne net.Error
	return errors.Is(err, context.DeadlineExceeded) || (errors.As(err, &ne) && ne.Timeout())
}

// errorBody follows the OpenAI error envelope so SDKs surface the message.
type errorBody struct {
	Error struct {
		Message string `json:"message"`
		Type    string `json:"type"`
		Code    string `json:"code"`
	} `json:"error"`
}

func (h *Handler) fail(w http.ResponseWriter, rec *record, v *policy.Violation) {
	rec.status, rec.reason = v.Status, v.Code
	var b errorBody
	b.Error.Message, b.Error.Type, b.Error.Code = v.Message, "stratum_error", v.Code
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(v.Status)
	json.NewEncoder(w).Encode(b)
}

func (h *Handler) finish(r *http.Request, rec *record) {
	h.Metrics.Request(rec.status, rec.provider, rec.reason)
	attrs := []any{
		"status", rec.status, "reason", rec.reason,
		"team_id", rec.teamID, "key_id", rec.keyID,
		"provider", rec.provider, "model", rec.model, "stream", rec.stream,
		"duration_ms", time.Since(rec.start).Milliseconds(), "upstream_ms", rec.upstreamMs,
		"tokens_in", rec.usage.Input, "tokens_out", rec.usage.Output,
	}
	if h.RequestID != nil {
		attrs = append(attrs, "request_id", h.RequestID(r.Context()))
	}
	if len(rec.piiTypes) > 0 {
		attrs = append(attrs, "content_flags", rec.piiTypes)
	}
	h.Log.Info("request", attrs...)
}
