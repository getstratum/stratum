// Package proxy is the request hot path: authenticate, route, enforce
// policy, scan for PII, forward to the provider and stream the answer back.
//
// Everything here reads from the in-memory snapshot. The only network call
// is the one to the LLM provider.
package proxy

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"math"
	"net"
	"net/http"
	"net/url"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/getstratum/stratum/gateway/internal/auth"
	"github.com/getstratum/stratum/gateway/internal/decision"
	"github.com/getstratum/stratum/gateway/internal/metrics"
	"github.com/getstratum/stratum/gateway/internal/pii"
	"github.com/getstratum/stratum/gateway/internal/policy"
	"github.com/getstratum/stratum/gateway/internal/provider"
	"github.com/getstratum/stratum/gateway/internal/quota"
	"github.com/getstratum/stratum/gateway/internal/resilience"
	"github.com/getstratum/stratum/gateway/internal/snapshot"
	"github.com/getstratum/stratum/gateway/internal/trace"
	"github.com/getstratum/stratum/gateway/internal/usage"
)

// Decider is the external decision services (ADR-0014, package decision).
type Decider interface {
	Check(context.Context, decision.Request) decision.Decision
	Report(decision.Report)
}

// UsageSink receives one record per authenticated request. Add must not
// block (usage.Pusher only appends to a buffer).
type UsageSink interface {
	Add(usage.Record)
}

type Handler struct {
	Holder            *snapshot.Holder
	Quota             quota.Enforcer
	Metrics           *metrics.Metrics
	Log               *slog.Logger
	Client            *http.Client
	MaxRequestBytes   int64
	StreamIdleTimeout time.Duration
	PIIEnabled        bool
	UserAgent         string
	RequestID         func(context.Context) string
	Usage             UsageSink // optional
	Decision          Decider   // optional: external decision services (ADR-0014)

	// OpenTelemetry traces (ADR-0013). A nil Traces turns them off; the
	// client's traceparent then goes to the provider unchanged.
	Traces    *trace.Exporter
	Sampler   trace.Sampler
	Propagate bool // send the gateway's own span as the provider's parent

	// Provider failures (ADR-0010). All optional: nil Breakers or Budget
	// turn that part off, Retry.Max 0 turns retries off.
	Breakers *resilience.Breakers
	Budget   *resilience.Budget
	Retry    RetryOptions
}

// RetryOptions bound retries before the first byte reaches the client.
type RetryOptions struct {
	Max     int           // retries per request
	MaxWait time.Duration // total time spent waiting between tries
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
	userID     string // the person a delegating key acted for
	provider   string
	model      string
	stream     bool
	upstreamMs int64
	usage      Usage
	piiTypes   []string
	labels     []string // X-Stratum-Labels, validated
	providerOK bool     // rec.provider is a configured provider
	operation  string   // gen_ai.operation.name, from the path
	sent       bool     // the request went to the provider
	keyLabel   string
	task       string // X-Stratum-Task, for the decision services
	content    string // SHA-256 of the request's content (contentHash)
	checked    bool   // the decision services were asked
	raw        []byte // the request body as it came, for an alias's later routes
	alias      string // the model alias the request named (ADR-0015)
	fallbacks  int    // how many of the alias's models failed before the one that answered

	// For the trace (ADR-0013).
	span, parent     trace.SpanContext
	hasParent        bool
	clientSpan       [8]byte
	upStart, upEnd   time.Time
	attempts         int
	decStart, decEnd time.Time
	decSpan          [8]byte
	decResult        string // allow, deny or skipped
	decCode          string
	upHost           string // server.address of the provider
	upStatus         int    // the provider's HTTP status, when it answered
}

func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	rec := &record{start: time.Now()}
	rec.parent, rec.hasParent = trace.Parse(r.Header.Get("Traceparent"), r.Header.Get("Tracestate"))
	if h.Traces != nil {
		rec.span = trace.Start(rec.parent, rec.hasParent, h.Sampler)
	}
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

	// ── Authenticate, and whose policy applies ──────────────────────────
	key, teamID, userID, v := h.caller(r, snap)
	rec.keyID = key.ID // empty when the key is not valid: the request is nobody's
	if v != nil {
		h.fail(w, rec, v)
		return
	}
	rec.teamID, rec.userID, rec.keyLabel = teamID, userID, key.Label

	// ── Labels from the application ─────────────────────────────────────
	labels, valid := parseLabels(r.Header.Values("X-Stratum-Labels"))
	rec.labels = labels
	if !valid {
		h.fail(w, rec, &policy.Violation{Status: http.StatusBadRequest, Code: "invalid_labels",
			Message: "X-Stratum-Labels takes up to 8 comma-separated labels of lowercase letters, digits and _ (1 to 40 each)"})
		return
	}

	// ── The task an application names, for the decision services ────────
	// and the trace. Only the decision services refuse a malformed one.
	if t := strings.TrimSpace(r.Header.Get("X-Stratum-Task")); t != "" {
		switch {
		case validTask(t):
			rec.task = t
		case h.Decision != nil:
			h.fail(w, rec, &policy.Violation{Status: http.StatusBadRequest, Code: "invalid_task",
				Message: "X-Stratum-Task takes 1 to 100 letters, digits and . _ : -"})
			return
		}
	}

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
	rec.raw = raw
	if err != nil {
		h.fail(w, rec, &policy.Violation{Status: http.StatusBadRequest, Code: "invalid_json", Message: "request body must be a JSON object"})
		return
	}
	if h.Decision != nil {
		rec.content = contentHash(body)
	}
	model, _ := body["model"].(string)
	rec.model = model // as asked, until the route is resolved: errors before that still say what was asked
	pol, polFound := snap.PolicyForTeam(teamID)

	// The request's API format: Anthropic Messages or OpenAI-compatible.
	anthropicFormat := strings.HasPrefix(upstreamPath, "v1/messages")

	// ── Where it goes: one route, or an alias's (ADR-0015) ──────────────
	var routes []route
	if alias := aliasName(explicit, key, model); alias != "" {
		var v *policy.Violation
		if routes, v = aliasRoutes(snap, pol, polFound, alias, upstreamPath, anthropicFormat); v != nil {
			h.fail(w, rec, v)
			return
		}
		rec.alias = alias
	} else {
		switch {
		case explicit:
			slug = strings.ToLower(slug)
			anthropicFormat = provider.KindOf(slug) == provider.KindAnthropic
			if pfx, rest, cut := strings.Cut(model, "/"); cut && strings.EqualFold(pfx, slug) {
				model = rest
			}
		case key.Provider != "" && key.Model != "":
			// An agent with a fixed model need not name one.
			slug = key.Provider
		default:
			if slug, model, ok = pickProvider(snap, pol, polFound, model); !ok {
				h.fail(w, rec, &policy.Violation{Status: http.StatusBadRequest, Code: "ambiguous_provider",
					Message: `cannot infer the provider; send "model": "provider/model" or call /proxy/{provider}/...`})
				return
			}
		}

		// ── Agent's fixed model ─────────────────────────────────────────
		// Set in the console: every request of the key goes to that model,
		// whatever it asked for, so an administrator can change it centrally.
		// It still has to pass the team's policy below.
		if key.Model != "" {
			to := key.Provider
			if to == "" {
				to = slug // only the model is fixed
			}
			if (provider.KindOf(to) == provider.KindAnthropic) != anthropicFormat {
				h.fail(w, rec, &policy.Violation{Status: http.StatusBadRequest, Code: "agent_model_mismatch",
					Message: "this agent is set to use " + to + "/" + key.Model + ", which takes a different API format than this request"})
				return
			}
			slug, model = to, key.Model
			w.Header().Set("X-Stratum-Routed-To", slug+"/"+model)
		}
		// Azure picks the model by the deployment in the URL, not the body: the
		// policy checks that name, and an agent's fixed model replaces it.
		if provider.KindOf(slug) == provider.KindAzure {
			if before, dep, after, found := cutDeployment(upstreamPath); found {
				if key.Model != "" {
					upstreamPath = before + url.PathEscape(key.Model) + after
				} else {
					model = dep
				}
			}
		}
		rec.provider, rec.model = slug, model

		// ── Policy ──────────────────────────────────────────────────────
		if v := policy.Check(pol, polFound, slug, model); v != nil {
			h.fail(w, rec, v)
			return
		}
		prov, ok := snap.Provider(slug)
		rec.providerOK = ok
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
		routes = []route{{slug: slug, model: model, prov: prov, base: base, kind: provider.KindOf(slug), path: upstreamPath}}
	}
	first := &routes[0]
	rec.provider, rec.model, rec.providerOK = first.slug, first.model, true
	kind := first.kind

	// ── Quota ───────────────────────────────────────────────────────────
	if v := h.Quota.Check(teamID, pol); v != nil {
		h.fail(w, rec, v)
		return
	}

	// ── The body for the provider, and PII / DLP ─────────────────────────
	rec.stream, _ = body["stream"].(bool)
	if v := h.prepare(w, rec, body, first, pol, polFound); v != nil {
		h.fail(w, rec, v)
		return
	}
	final := first.final

	// ── External decision services (ADR-0014) ───────────────────────────
	if h.Decision != nil {
		rec.checked = true
		var requestID string
		if h.RequestID != nil {
			requestID = h.RequestID(r.Context())
		}
		var traceparent string
		if h.Traces != nil {
			rec.decSpan = trace.NewSpanID()
			if h.Propagate {
				traceparent = trace.SpanContext{TraceID: rec.span.TraceID, SpanID: rec.decSpan, Sampled: rec.span.Sampled}.Traceparent()
			}
		}
		rec.decStart = time.Now()
		d := h.Decision.Check(r.Context(), decision.Request{
			RequestID: requestID, Time: rec.start.UTC().Format(time.RFC3339Nano),
			KeyID: rec.keyID, KeyLabel: rec.keyLabel, TeamID: rec.teamID, UserID: rec.userID, Task: rec.task,
			Provider: rec.provider, Model: rec.model, Operation: operationName(first.path, kind), Stream: rec.stream,
			Labels: rec.labels, ContentSHA256: rec.content, ContentBytes: len(final), Traceparent: traceparent,
		})
		rec.decEnd = time.Now()
		switch {
		case !d.Allow:
			rec.decResult, rec.decCode = "deny", d.Code
		case d.Skipped:
			rec.decResult = "skipped"
		default:
			rec.decResult = "allow"
		}
		for k, v := range d.Headers {
			w.Header().Set(k, v)
		}
		if !d.Allow {
			h.fail(w, rec, &policy.Violation{Status: d.Status, Code: d.Code, Message: d.Message})
			return
		}
		extra := d.Labels
		if d.Skipped {
			extra = append(extra, "decision_skipped")
		}
		rec.labels = mergeLabels(rec.labels, extra)
	}

	// ── Forward, retrying before the first byte (ADR-0010), then the
	//    alias's next model while nothing reached the client (ADR-0015) ──
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	if h.Traces != nil {
		rec.clientSpan = trace.NewSpanID()
	}
	rec.upStart = time.Now()
	rec.sent, rec.operation = true, operationName(first.path, first.kind)
	var (
		res *http.Response
		att sent
		rt  *route
	)
	for i := range routes {
		rt = &routes[i]
		rec.provider, rec.model = rt.slug, rt.model
		target := provider.TargetURL(rt.prov, rt.base, rt.path, r.URL.RawQuery)
		build := func() (*http.Request, error) {
			rec.attempts++
			ureq, err := http.NewRequestWithContext(ctx, http.MethodPost, target, bytes.NewReader(rt.final))
			if err != nil {
				return nil, err
			}
			rec.upHost = ureq.URL.Hostname()
			h.traceHeaders(ureq.Header, r.Header, rec)
			ureq.Header.Set("Content-Type", "application/json")
			for _, name := range []string{"Accept", "Anthropic-Version", "Anthropic-Beta", "OpenAI-Beta"} {
				if v := r.Header.Get(name); v != "" {
					ureq.Header.Set(name, v)
				}
			}
			if h.UserAgent != "" {
				ureq.Header.Set("User-Agent", h.UserAgent)
			}
			provider.SetAuth(ureq.Header, rt.prov)
			return ureq, nil
		}
		res, att, err = h.send(ctx, rt.prov.ID, build)
		if i+1 == len(routes) || r.Context().Err() != nil || !fallsOver(res, err) {
			break
		}
		next := &routes[i+1]
		if v := h.prepare(w, rec, nil, next, pol, polFound); v != nil {
			break // cannot happen with a body the first route took; keep this answer
		}
		why := "error"
		if res != nil {
			why = strconv.Itoa(res.StatusCode)
			h.outcome(rt.prov.ID, att, false, false)
			io.Copy(io.Discard, io.LimitReader(res.Body, 64<<10))
			res.Body.Close()
		} else if errors.As(err, new(*breakerOpenError)) {
			why = "paused"
		}
		rec.fallbacks++
		h.Metrics.AliasFallbacks.Add(1)
		h.Log.Warn("alias falling back", "alias", rec.alias, "from", rt.slug+"/"+rt.model, "to", next.slug+"/"+next.model, "why", why)
	}
	rec.upstreamMs = time.Since(rec.upStart).Milliseconds()
	if rec.alias != "" {
		w.Header().Set("X-Stratum-Routed-To", rt.slug+"/"+rt.model)
		if rec.fallbacks > 0 {
			rec.labels = mergeLabels(rec.labels, []string{"routed_fallback"})
		}
	}
	if err != nil {
		rec.upEnd = time.Now()
		var paused *breakerOpenError
		switch {
		case errors.As(err, &paused):
			w.Header().Set("Retry-After", strconv.Itoa(int(math.Ceil(paused.wait.Seconds()))))
			h.fail(w, rec, &policy.Violation{Status: http.StatusServiceUnavailable, Code: "provider_unavailable",
				Message: "the AI provider is failing; requests to it are paused, retry after " + strconv.Itoa(int(math.Ceil(paused.wait.Seconds()))) + " s"})
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
	rec.status, rec.reason, rec.upStatus = res.StatusCode, "ok", res.StatusCode
	if res.StatusCode >= 400 {
		rec.reason = "upstream_status"
	}

	usage, perr := pump(w, res.Body, cancel, h.StreamIdleTimeout, rec.stream && res.StatusCode == http.StatusOK, rt.kind)
	rec.usage, rec.upEnd = usage, time.Now()
	switch {
	case perr == nil:
	case errors.Is(perr, errIdle):
		rec.reason = "stream_idle_timeout"
	case r.Context().Err() != nil:
		rec.reason = "client_closed"
	default:
		rec.reason = "upstream_aborted"
	}
	h.outcome(rt.prov.ID, att, rec.reason == "stream_idle_timeout" || rec.reason == "upstream_aborted",
		rec.reason == "client_closed")

	if total := usage.Input + usage.Output; total > 0 {
		h.Quota.Add(teamID, total)
		h.Metrics.UpstreamTokens.Add(total)
	}
}

// caller authenticates the request's key and resolves whose policy applies:
// the key's team, or, for a key that delegates (an application such as a
// chat portal), the team of the person named in X-Stratum-User, whose usage
// the request then is. Any other key sending the header is refused rather
// than ignored, so a misconfigured application cannot spend under its own
// team without noticing. key.ID is set whenever the key is valid, refused
// or not, so the refusal is reported under it.
func (h *Handler) caller(r *http.Request, snap *snapshot.Snapshot) (key snapshot.Key, teamID, userID string, v *policy.Violation) {
	key, err := auth.Resolve(snap, auth.ExtractKey(r))
	if err != nil {
		code := "invalid_api_key"
		if errors.Is(err, auth.ErrMissingKey) {
			code = "missing_api_key"
		}
		return snapshot.Key{}, "", "", &policy.Violation{Status: http.StatusUnauthorized, Code: code, Message: err.Error()}
	}
	person := r.Header.Get("X-Stratum-User")
	if person == "" {
		return key, key.TeamID, "", nil
	}
	if !key.Delegates {
		return key, "", "", &policy.Violation{Status: http.StatusForbidden, Code: "delegation_not_allowed",
			Message: "this key cannot act on behalf of a person"}
	}
	team, ok := snap.Person(person)
	if !ok {
		return key, "", "", &policy.Violation{Status: http.StatusForbidden, Code: "unknown_user",
			Message: "the person in X-Stratum-User does not exist or may not use applications"}
	}
	return key, team, person, nil
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
	// The provider label only for configured providers: the name in
	// /proxy/{provider}/ is the client's, and labels must stay few.
	label := rec.provider
	if !rec.providerOK {
		label = ""
	}
	h.Metrics.Request(rec.status, label, rec.reason)
	if rec.sent {
		op := metrics.GenAIOp{Operation: rec.operation, Provider: rec.provider, Model: usage.Clip(rec.model, 100),
			Seconds: time.Since(rec.start).Seconds(), TokensIn: rec.usage.Input, TokensOut: rec.usage.Output}
		switch {
		case rec.reason == "upstream_status":
			op.ErrorType = strconv.Itoa(rec.status) // the provider's HTTP status, as the conventions do
		case rec.reason != "ok":
			op.ErrorType = rec.reason
		}
		h.Metrics.GenAI(op)
	}
	duration := time.Since(rec.start).Milliseconds()
	var requestID string
	if h.RequestID != nil {
		requestID = h.RequestID(r.Context())
	}
	// Usage is reported for every request made with a valid key, refused
	// ones included: the console shows denials too. Requests without a
	// valid key belong to no organization and are only logged and counted.
	if h.Usage != nil && rec.keyID != "" {
		h.Usage.Add(usage.Record{
			ID: usage.NewID(), Time: rec.start.UTC(), RequestID: usage.Clip(requestID, 128),
			KeyID: rec.keyID, UserID: rec.userID, TeamID: rec.teamID, Provider: usage.Clip(rec.provider, 50), Model: usage.Clip(rec.model, 100),
			Status: rec.status, Reason: rec.reason, Stream: rec.stream,
			DurationMs: duration, UpstreamMs: rec.upstreamMs,
			TokensIn: rec.usage.Input, TokensOut: rec.usage.Output, ContentFlags: rec.piiTypes, Labels: rec.labels,
		})
	}
	attrs := []any{
		"status", rec.status, "reason", rec.reason,
		"team_id", rec.teamID, "key_id", rec.keyID,
		"provider", usage.Clip(rec.provider, 50), "model", usage.Clip(rec.model, 100), "stream", rec.stream,
		"duration_ms", duration, "upstream_ms", rec.upstreamMs,
		"tokens_in", rec.usage.Input, "tokens_out", rec.usage.Output,
	}
	if requestID != "" {
		attrs = append(attrs, "request_id", requestID)
	}
	if rec.userID != "" {
		attrs = append(attrs, "user_id", rec.userID)
	}
	if len(rec.piiTypes) > 0 {
		attrs = append(attrs, "content_flags", rec.piiTypes)
	}
	if len(rec.labels) > 0 {
		attrs = append(attrs, "labels", rec.labels)
	}
	if rec.alias != "" {
		attrs = append(attrs, "alias", rec.alias, "fallbacks", rec.fallbacks)
	}
	if rec.span.Valid() {
		attrs = append(attrs, "trace_id", rec.span.TraceHex())
	} else if rec.hasParent {
		attrs = append(attrs, "trace_id", rec.parent.TraceHex())
	}
	h.Log.Info("request", attrs...)
	h.exportSpans(r, rec)

	if h.Decision != nil && rec.checked {
		h.Decision.Report(decision.Report{
			RequestID: usage.Clip(requestID, 128), Time: rec.start.UTC().Format(time.RFC3339Nano),
			KeyID: rec.keyID, TeamID: rec.teamID, UserID: rec.userID, Task: rec.task,
			Provider: usage.Clip(rec.provider, 50), Model: usage.Clip(rec.model, 100), ContentSHA256: rec.content,
			Status: rec.status, Reason: rec.reason, TokensIn: rec.usage.Input, TokensOut: rec.usage.Output,
			DurationMs: duration, UpstreamMs: rec.upstreamMs,
		})
	}
}

// contentHash is the SHA-256 of what a request asks, without how: the
// messages, prompt or input, and the system prompt, not the model or the
// sampling settings. Two requests with the same content have the same
// hash, so a decision service can tell a loop without seeing the text.
// json.Marshal sorts map keys, so the hash does not depend on key order.
func contentHash(body map[string]any) string {
	content := map[string]any{}
	for _, k := range []string{"messages", "prompt", "input", "system", "instructions", "contents"} {
		if v, ok := body[k]; ok {
			content[k] = v
		}
	}
	if len(content) == 0 {
		return ""
	}
	b, err := json.Marshal(content)
	if err != nil {
		return ""
	}
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

func validTask(t string) bool {
	if len(t) > 100 {
		return false
	}
	for _, c := range t {
		if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '.' || c == '_' || c == ':' || c == '-') {
			return false
		}
	}
	return true
}

// mergeLabels adds a decision service's labels to the application's,
// sorted, without repeats, at most maxLabels: the application's first.
func mergeLabels(have, add []string) []string {
	out := append([]string(nil), have...)
	for _, l := range add {
		if len(out) >= maxLabels {
			break
		}
		if !slices.Contains(out, l) && validLabel(l) {
			out = append(out, l)
		}
	}
	slices.Sort(out)
	return out
}

// operationName is gen_ai.operation.name for a provider path.
func operationName(upstreamPath string, kind provider.Kind) string {
	p := strings.TrimSuffix(upstreamPath, "/")
	switch {
	case kind == provider.KindAnthropic && strings.HasSuffix(p, "messages"):
		return "chat"
	case strings.HasSuffix(p, "chat/completions"), strings.HasSuffix(p, "responses"):
		return "chat"
	case strings.HasSuffix(p, "completions"):
		return "text_completion"
	case strings.HasSuffix(p, "embeddings"):
		return "embeddings"
	case strings.Contains(p, ":generateContent"), strings.Contains(p, ":streamGenerateContent"):
		return "generate_content"
	}
	return "other"
}

// cutDeployment splits an Azure path around its deployment name:
// "openai/deployments/{name}/chat/completions".
func cutDeployment(p string) (before, name, after string, ok bool) {
	i := strings.Index("/"+p, "/deployments/")
	if i < 0 {
		return "", "", "", false
	}
	before = p[:i+len("deployments/")]
	name, rest, slash := strings.Cut(p[len(before):], "/")
	if slash {
		after = "/" + rest
	}
	if unescaped, err := url.PathUnescape(name); err == nil {
		name = unescaped
	}
	if name == "" {
		return "", "", "", false
	}
	return before, name, after, true
}
