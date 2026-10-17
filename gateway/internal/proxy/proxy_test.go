package proxy

import (
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/getstratum/stratum/gateway/internal/auth"
	"github.com/getstratum/stratum/gateway/internal/metrics"
	"github.com/getstratum/stratum/gateway/internal/quota"
	"github.com/getstratum/stratum/gateway/internal/resilience"
	"github.com/getstratum/stratum/gateway/internal/snapshot"
	"github.com/getstratum/stratum/gateway/internal/usage"
)

type usageRecorder struct {
	mu      sync.Mutex
	records []usage.Record
}

func (u *usageRecorder) Add(r usage.Record) {
	u.mu.Lock()
	u.records = append(u.records, r)
	u.mu.Unlock()
}

// wait returns the records once there are n (finish runs after the
// response is written, so the client can see the answer first).
func (u *usageRecorder) wait(t *testing.T, n int) []usage.Record {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for {
		u.mu.Lock()
		got := append([]usage.Record(nil), u.records...)
		u.mu.Unlock()
		if len(got) >= n || time.Now().After(deadline) {
			return got
		}
		time.Sleep(5 * time.Millisecond)
	}
}

const (
	devKey    = "aig_sk_eng_test1234567890"
	agentKey  = "aig_agt_fixed_model_test_000000"
	agentKey2 = "aig_agt_fixed_model_only_000000"
)

// upstream records what the gateway forwarded and replies with a canned body.
type upstream struct {
	mu      sync.Mutex
	path    string
	header  http.Header
	body    map[string]any
	handler func(w http.ResponseWriter, r *http.Request)
}

func (u *upstream) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	raw, _ := io.ReadAll(r.Body)
	u.mu.Lock()
	u.path = r.URL.RequestURI()
	u.header = r.Header.Clone()
	u.body = nil
	json.Unmarshal(raw, &u.body)
	u.mu.Unlock()
	u.handler(w, r)
}

type env struct {
	t     *testing.T
	gw    *httptest.Server
	up    *upstream
	quota *quota.Local
	m     *metrics.Metrics
	usage *usageRecorder
}

func newEnv(t *testing.T, policyJSON string, idle time.Duration, configure ...func(*Handler)) *env {
	t.Helper()
	up := &upstream{handler: func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("X-Request-Id", "req_up_1")
		io.WriteString(w, `{"id":"x","choices":[],"usage":{"prompt_tokens":11,"completion_tokens":7}}`)
	}}
	upSrv := httptest.NewServer(up)
	t.Cleanup(upSrv.Close)

	syncJSON := fmt.Sprintf(`{
	  "current_version": 3,
	  "policies": [%s],
	  "api_keys": [
	    {"id":"u1","key_hash":%q,"team_id":"t1","version":1,"revoked":false},
	    {"id":"agent:a1","key_hash":%q,"team_id":"t1","version":1,"revoked":false,"default_provider":"openai","default_model":"gpt-4o-mini"},
	    {"id":"agent:a2","key_hash":%q,"team_id":"t1","version":1,"revoked":false,"default_model":"o3-mini"}
	  ],
	  "provider_configs": [
	    {"id":"oa","provider":"openai","api_key":"sk-up","base_url":%q,"enabled":true,"version":2,"revoked":false},
	    {"id":"an","provider":"anthropic","api_key":"ak-up","base_url":%q,"enabled":true,"version":2,"revoked":false},
	    {"id":"az","provider":"azure","api_key":"az-up","base_url":%q,"enabled":true,"version":2,"revoked":false}
	  ]}`, policyJSON, auth.HashKey(devKey), auth.HashKey(agentKey), auth.HashKey(agentKey2), upSrv.URL, upSrv.URL, upSrv.URL+"/openai")
	var resp snapshot.SyncResponse
	if err := json.Unmarshal([]byte(syncJSON), &resp); err != nil {
		t.Fatal(err)
	}
	st, err := (*snapshot.State)(nil).Apply(&resp, true)
	if err != nil {
		t.Fatal(err)
	}
	holder := &snapshot.Holder{}
	holder.Store(st, snapshot.Build(st, time.Now()))

	e := &env{t: t, up: up, quota: quota.NewLocal(), m: metrics.New(), usage: &usageRecorder{}}
	h := &Handler{
		Holder: holder, Quota: e.quota, Metrics: e.m,
		Log:               slog.New(slog.NewTextHandler(io.Discard, nil)),
		Client:            &http.Client{Transport: NewTransport(5 * time.Second)},
		MaxRequestBytes:   1 << 20,
		StreamIdleTimeout: idle,
		PIIEnabled:        true,
		UserAgent:         "stratum-gateway/test",
		Usage:             e.usage,
	}
	for _, f := range configure {
		f(h)
	}
	e.gw = httptest.NewServer(h)
	t.Cleanup(e.gw.Close)
	return e
}

const allowAll = `{"id":"p","team_id":"t1","version":1,"allow_all_models":true,"pii_action":"redact","dlp_action":"block"}`

func (e *env) post(path, key, body string) *http.Response {
	e.t.Helper()
	req, _ := http.NewRequest(http.MethodPost, e.gw.URL+path, strings.NewReader(body))
	if key != "" {
		req.Header.Set("Authorization", "Bearer "+key)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		e.t.Fatal(err)
	}
	e.t.Cleanup(func() { res.Body.Close() })
	return res
}

func errCode(t *testing.T, res *http.Response) string {
	t.Helper()
	var b errorBody
	json.NewDecoder(res.Body).Decode(&b)
	return b.Error.Code
}

func TestAuth(t *testing.T) {
	e := newEnv(t, allowAll, time.Minute)
	if res := e.post("/v1/chat/completions", "", `{}`); res.StatusCode != 401 || errCode(t, res) != "missing_api_key" {
		t.Fatalf("missing key: %d", res.StatusCode)
	}
	if res := e.post("/v1/chat/completions", "nope", `{}`); res.StatusCode != 401 || errCode(t, res) != "invalid_api_key" {
		t.Fatalf("bad key: %d", res.StatusCode)
	}
}

func TestUsageRecordedForAuthenticatedRequests(t *testing.T) {
	e := newEnv(t, allowAll, time.Minute)
	if res := e.post("/v1/chat/completions", "nope", `{}`); res.StatusCode != 401 {
		t.Fatalf("bad key: %d", res.StatusCode)
	}
	res := e.post("/v1/chat/completions", devKey, `{"model":"openai/gpt-4o","messages":[{"role":"user","content":"mail ana@example.com"}]}`)
	if res.StatusCode != 200 {
		t.Fatalf("status %d", res.StatusCode)
	}
	if res := e.post("/v1/chat/completions", devKey, `{"model":"mistral/large","messages":[]}`); res.StatusCode != 400 {
		t.Fatalf("unknown provider: %d", res.StatusCode)
	}

	got := e.usage.wait(t, 2)
	if len(got) != 2 {
		t.Fatalf("%d usage records, want 2 (the request without a valid key is not reported)", len(got))
	}
	ok := got[0]
	if ok.KeyID != "u1" || ok.TeamID != "t1" || ok.Provider != "openai" || ok.Model != "gpt-4o" ||
		ok.Status != 200 || ok.Reason != "ok" || ok.TokensIn != 11 || ok.TokensOut != 7 {
		t.Errorf("record = %+v", ok)
	}
	if len(ok.ContentFlags) == 0 || ok.ID == "" || ok.ID == got[1].ID || ok.Time.IsZero() {
		t.Errorf("flags=%v id=%q time=%v", ok.ContentFlags, ok.ID, ok.Time)
	}
	if got[1].Status != 400 || got[1].TokensIn != 0 {
		t.Errorf("refused request record = %+v", got[1])
	}

	// CI checks what the gateway really sends against api/usage/v1.
	if dir := os.Getenv("USAGE_EXAMPLES_DIR"); dir != "" {
		b, err := json.MarshalIndent(usage.Batch{InstanceID: "dp_test", Records: got}, "", "  ")
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, "proxy-records.json"), b, 0o644); err != nil {
			t.Fatal(err)
		}
	}
}

func TestRoutingAndForwarding(t *testing.T) {
	e := newEnv(t, allowAll, time.Minute)

	res := e.post("/v1/chat/completions", devKey, `{"model":"openai/gpt-4o","seed":9007199254740993,"messages":[]}`)
	if res.StatusCode != 200 {
		t.Fatalf("status %d", res.StatusCode)
	}
	if e.up.path != "/v1/chat/completions" || e.up.body["model"] != "gpt-4o" {
		t.Fatalf("forwarded %s model=%v", e.up.path, e.up.body["model"])
	}
	if e.up.header.Get("Authorization") != "Bearer sk-up" {
		t.Fatal("provider key not injected / developer key leaked upstream")
	}
	if res.Header.Get("X-Request-Id") != "req_up_1" {
		t.Fatal("upstream headers not passed through")
	}
	if e.quota.Used("t1") != 18 {
		t.Fatalf("usage not counted: %d", e.quota.Used("t1"))
	}

	// Explicit provider route, Anthropic auth headers.
	e.post("/proxy/anthropic/v1/messages", devKey, `{"model":"claude-sonnet-4","messages":[]}`)
	if e.up.header.Get("X-Api-Key") != "ak-up" || e.up.header.Get("Anthropic-Version") == "" {
		t.Fatalf("anthropic headers: %v", e.up.header)
	}

	// Two providers configured, no prefix: the gateway must not guess.
	if res := e.post("/v1/chat/completions", devKey, `{"model":"gpt-4o"}`); res.StatusCode != 400 || errCode(t, res) != "ambiguous_provider" {
		t.Fatalf("ambiguous: %d", res.StatusCode)
	}
}

func TestRefusalsBeforeRoutingRecordTheModelAsked(t *testing.T) {
	e := newEnv(t, allowAll, time.Minute)
	res := e.post("/v1/chat/completions", devKey, `{"model":"llama3","messages":[]}`)
	if res.StatusCode != 400 || errCode(t, res) != "ambiguous_provider" {
		t.Fatalf("status %d", res.StatusCode)
	}
	if r := e.usage.wait(t, 1)[0]; r.Model != "llama3" || r.Provider != "" || r.Reason != "ambiguous_provider" {
		t.Errorf("usage record = %+v", r)
	}
}

func TestAgentFixedModel(t *testing.T) {
	e := newEnv(t, allowAll, time.Minute)

	// Whatever it asks for, the agent's requests go to its model.
	res := e.post("/v1/chat/completions", agentKey, `{"model":"anthropic/claude-sonnet-4-6","messages":[]}`)
	if res.StatusCode != 200 || e.up.body["model"] != "gpt-4o-mini" || e.up.header.Get("Authorization") != "Bearer sk-up" {
		t.Fatalf("status %d, forwarded model %v auth %q", res.StatusCode, e.up.body["model"], e.up.header.Get("Authorization"))
	}
	if got := res.Header.Get("X-Stratum-Routed-To"); got != "openai/gpt-4o-mini" {
		t.Errorf("X-Stratum-Routed-To = %q", got)
	}
	// It need not name a model, even with several providers configured.
	if res := e.post("/v1/chat/completions", agentKey, `{"messages":[]}`); res.StatusCode != 200 || e.up.body["model"] != "gpt-4o-mini" {
		t.Fatalf("no model: status %d, forwarded %v", res.StatusCode, e.up.body["model"])
	}
	// A request in the other API format cannot be sent to it.
	if res := e.post("/v1/messages", agentKey, `{"model":"claude-sonnet-4-6","messages":[]}`); res.StatusCode != 400 || errCode(t, res) != "agent_model_mismatch" {
		t.Fatalf("other format: %d", res.StatusCode)
	}
	if res := e.post("/proxy/anthropic/v1/messages", agentKey, `{"messages":[]}`); res.StatusCode != 400 || errCode(t, res) != "agent_model_mismatch" {
		t.Fatalf("other format, explicit provider: %d", res.StatusCode)
	}
	// Only the model fixed: the provider stays the one requested.
	if res := e.post("/v1/chat/completions", agentKey2, `{"model":"openai/gpt-4o","messages":[]}`); res.StatusCode != 200 || e.up.body["model"] != "o3-mini" {
		t.Fatalf("model only: status %d, forwarded %v", res.StatusCode, e.up.body["model"])
	}
	// People's keys are untouched.
	if res := e.post("/v1/chat/completions", devKey, `{"model":"openai/gpt-4o","messages":[]}`); res.StatusCode != 200 || e.up.body["model"] != "gpt-4o" || res.Header.Get("X-Stratum-Routed-To") != "" {
		t.Fatalf("person: status %d, forwarded %v", res.StatusCode, e.up.body["model"])
	}
	// The usage record has the model actually used.
	got := e.usage.wait(t, 6)
	if r := got[0]; r.KeyID != "agent:a1" || r.Provider != "openai" || r.Model != "gpt-4o-mini" {
		t.Errorf("usage record = %+v", r)
	}
}

func TestAzureDeploymentIsTheModel(t *testing.T) {
	// Azure runs the deployment named in the URL whatever the body says.
	e := newEnv(t, `{"id":"p","team_id":"t1","version":1,"allowed_models":["gpt-4o","o3-mini"]}`, time.Minute)
	path := "/proxy/azure/deployments/gpt-5/chat/completions"
	if res := e.post(path, devKey, `{"model":"gpt-4o","messages":[]}`); res.StatusCode != 403 || errCode(t, res) != "model_not_allowed" {
		t.Fatalf("deployment outside the policy: %d", res.StatusCode)
	}
	if res := e.post("/proxy/azure/deployments/gpt-4o/chat/completions", devKey, `{"messages":[]}`); res.StatusCode != 200 {
		t.Fatalf("allowed deployment: %d", res.StatusCode)
	}
	// An agent's fixed model replaces the deployment.
	res := e.post(path, agentKey2, `{"messages":[]}`)
	if res.StatusCode != 200 || !strings.HasPrefix(e.up.path, "/openai/deployments/o3-mini/chat/completions") {
		t.Fatalf("fixed model: status %d, upstream path %q", res.StatusCode, e.up.path)
	}
}

func TestCutDeployment(t *testing.T) {
	for _, c := range []struct{ in, before, name, after string }{
		{"openai/deployments/gpt-4o/chat/completions", "openai/deployments/", "gpt-4o", "/chat/completions"},
		{"deployments/x", "deployments/", "x", ""},
		{"openai/deployments/my%20dep/embeddings", "openai/deployments/", "my dep", "/embeddings"},
	} {
		b, n, a, ok := cutDeployment(c.in)
		if !ok || b != c.before || n != c.name || a != c.after {
			t.Errorf("cutDeployment(%q) = %q %q %q %v", c.in, b, n, a, ok)
		}
	}
	for _, in := range []string{"v1/chat/completions", "openai/mydeployments/x/y", "openai/deployments/"} {
		if _, _, _, ok := cutDeployment(in); ok {
			t.Errorf("cutDeployment(%q) found one", in)
		}
	}
}

func TestAgentFixedModelStillNeedsThePolicy(t *testing.T) {
	e := newEnv(t, `{"id":"p","team_id":"t1","version":1,"allowed_models":["gpt-4o"]}`, time.Minute)
	if res := e.post("/v1/chat/completions", agentKey, `{"model":"openai/gpt-4o"}`); res.StatusCode != 403 || errCode(t, res) != "model_not_allowed" {
		t.Fatalf("fixed model outside the policy: %d", res.StatusCode)
	}
}

func TestPolicyEnforced(t *testing.T) {
	e := newEnv(t, `{"id":"p","team_id":"t1","version":1,"allowed_models":["gpt-4o-mini"],"monthly_token_quota":10}`, time.Minute)
	if res := e.post("/v1/chat/completions", devKey, `{"model":"openai/gpt-4o"}`); res.StatusCode != 403 || errCode(t, res) != "model_not_allowed" {
		t.Fatalf("model policy: %d", res.StatusCode)
	}
	if res := e.post("/v1/chat/completions", devKey, `{"model":"openai/gpt-4o-mini"}`); res.StatusCode != 200 {
		t.Fatalf("allowed model: %d", res.StatusCode)
	}
	// 18 tokens used > quota of 10
	if res := e.post("/v1/chat/completions", devKey, `{"model":"openai/gpt-4o-mini"}`); res.StatusCode != 429 || errCode(t, res) != "quota_exceeded" {
		t.Fatalf("quota: %d", res.StatusCode)
	}
}

func TestContentRules(t *testing.T) {
	e := newEnv(t, allowAll, time.Minute)

	res := e.post("/v1/chat/completions", devKey, `{"model":"openai/gpt-4o","messages":[{"role":"user","content":"write to ana@acme.com"}]}`)
	if res.StatusCode != 200 {
		t.Fatalf("status %d", res.StatusCode)
	}
	msg := e.up.body["messages"].([]any)[0].(map[string]any)["content"].(string)
	if strings.Contains(msg, "ana@acme.com") || !strings.Contains(msg, "[REDACTED:EMAIL]") {
		t.Fatalf("email not redacted upstream: %q", msg)
	}

	res = e.post("/v1/chat/completions", devKey, `{"model":"openai/gpt-4o","messages":[{"role":"user","content":"my key sk-abcdefghijklmnopqrstuvwxyz123456"}]}`)
	if res.StatusCode != 403 || errCode(t, res) != "sensitive_data_detected" {
		t.Fatalf("secret must be blocked, got %d", res.StatusCode)
	}
}

func TestStreamingPassthroughAndUsage(t *testing.T) {
	e := newEnv(t, allowAll, time.Minute)
	e.up.handler = func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		f := w.(http.Flusher)
		for _, chunk := range []string{
			"data: {\"choices\":[{\"delta\":{\"content\":\"Hi\"}}]}\n\n",
			"data: {\"choices\":[],\"usage\":{\"prompt_tokens\":5,\"completion_tokens\":2}}\n\n",
			"data: [DONE]\n\n",
		} {
			io.WriteString(w, chunk)
			f.Flush()
		}
	}
	res := e.post("/v1/chat/completions", devKey, `{"model":"openai/gpt-4o","stream":true}`)
	got, _ := io.ReadAll(res.Body)
	if !strings.Contains(string(got), `"content":"Hi"`) || !strings.HasSuffix(string(got), "data: [DONE]\n\n") {
		t.Fatalf("stream not passed through verbatim: %q", got)
	}
	if opts, _ := e.up.body["stream_options"].(map[string]any); opts["include_usage"] != true {
		t.Fatal("include_usage not requested from OpenAI-compatible provider")
	}
	if e.quota.Used("t1") != 7 {
		t.Fatalf("stream usage = %d", e.quota.Used("t1"))
	}
}

func TestAnthropicStreamUsage(t *testing.T) {
	e := newEnv(t, allowAll, time.Minute)
	e.up.handler = func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		io.WriteString(w, "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":20}}}\n\n")
		io.WriteString(w, "event: message_delta\ndata: {\"type\":\"message_delta\",\"usage\":{\"output_tokens\":4}}\n\n")
	}
	res := e.post("/proxy/anthropic/v1/messages", devKey, `{"model":"claude-sonnet-4","stream":true}`)
	io.ReadAll(res.Body)
	if _, set := e.up.body["stream_options"]; set {
		t.Fatal("stream_options must not be sent to Anthropic")
	}
	if e.quota.Used("t1") != 24 {
		t.Fatalf("anthropic usage = %d", e.quota.Used("t1"))
	}
}

func TestStreamIdleWatchdog(t *testing.T) {
	e := newEnv(t, allowAll, 150*time.Millisecond)
	release := make(chan struct{})
	t.Cleanup(func() { close(release) })
	e.up.handler = func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		io.WriteString(w, "data: {\"choices\":[]}\n\n")
		w.(http.Flusher).Flush()
		select { // provider hangs mid-stream
		case <-release:
		case <-r.Context().Done():
		}
	}
	start := time.Now()
	res := e.post("/v1/chat/completions", devKey, `{"model":"openai/gpt-4o","stream":true}`)
	io.ReadAll(res.Body)
	if took := time.Since(start); took > 3*time.Second {
		t.Fatalf("watchdog did not cut the hung stream (took %v)", took)
	}
}

func TestBodyLimitAndBadJSON(t *testing.T) {
	e := newEnv(t, allowAll, time.Minute)
	big := `{"model":"openai/gpt-4o","x":"` + strings.Repeat("a", 2<<20) + `"}`
	if res := e.post("/v1/chat/completions", devKey, big); res.StatusCode != 413 {
		t.Fatalf("oversized body: %d", res.StatusCode)
	}
	if res := e.post("/v1/chat/completions", devKey, `[1,2]`); res.StatusCode != 400 {
		t.Fatalf("non-object body: %d", res.StatusCode)
	}
}

func TestUpstreamDown(t *testing.T) {
	e := newEnv(t, allowAll, time.Minute)
	e.up.handler = func(w http.ResponseWriter, r *http.Request) {
		hj, _ := w.(http.Hijacker)
		c, _, _ := hj.Hijack()
		c.Close() // connection reset before any response
	}
	res := e.post("/v1/chat/completions", devKey, `{"model":"openai/gpt-4o"}`)
	if res.StatusCode != 502 || errCode(t, res) != "upstream_unreachable" {
		t.Fatalf("got %d", res.StatusCode)
	}
}

// resilient turns on retries (2, short waits) and a breaker that opens after
// three failures in a row.
func resilient(h *Handler) {
	h.Retry = RetryOptions{Max: 2, MaxWait: 5 * time.Second}
	h.Budget = resilience.NewBudget(1, 100, 100)
	h.Breakers = resilience.NewBreakers(resilience.BreakerOptions{Threshold: 3, Cooldown: 200 * time.Millisecond})
}

// flaky answers with the given statuses in order, then 200.
func flaky(statuses ...int) (func(w http.ResponseWriter, r *http.Request), *atomic.Int32) {
	var calls atomic.Int32
	return func(w http.ResponseWriter, r *http.Request) {
		n := int(calls.Add(1))
		if n <= len(statuses) {
			w.WriteHeader(statuses[n-1])
			io.WriteString(w, `{"error":{"message":"busy"}}`)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, `{"id":"x","choices":[],"usage":{"prompt_tokens":11,"completion_tokens":7}}`)
	}, &calls
}

func TestRetriesBeforeTheFirstByte(t *testing.T) {
	e := newEnv(t, allowAll, time.Minute, resilient)
	var calls *atomic.Int32
	e.up.handler, calls = flaky(503, 502)
	res := e.post("/v1/chat/completions", devKey, `{"model":"openai/gpt-4o"}`)
	if res.StatusCode != 200 || calls.Load() != 3 {
		t.Fatalf("status %d after %d calls, want 200 after 3", res.StatusCode, calls.Load())
	}
	if e.m.UpstreamRetries.Load() != 2 {
		t.Errorf("retries metric = %d", e.m.UpstreamRetries.Load())
	}
	// The usage of the answer that worked is counted, once.
	if got := e.usage.wait(t, 1); len(got) != 1 || got[0].TokensIn != 11 || got[0].Status != 200 {
		t.Errorf("usage = %+v", got)
	}
}

func TestRetriesGiveUpAndAnswerWhatTheProviderSaid(t *testing.T) {
	e := newEnv(t, allowAll, time.Minute, resilient)
	var calls *atomic.Int32
	e.up.handler, calls = flaky(503, 503, 503, 503)
	if res := e.post("/v1/chat/completions", devKey, `{"model":"openai/gpt-4o"}`); res.StatusCode != 503 || calls.Load() != 3 {
		t.Fatalf("status %d after %d calls, want the provider's 503 after 1 + 2 retries", res.StatusCode, calls.Load())
	}
}

func TestNotRetried(t *testing.T) {
	for name, handler := range map[string]func(w http.ResponseWriter, r *http.Request){
		"400 (the request)":        func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(400) },
		"500 (may be the request)": func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(500) },
		"429 asking for a long wait": func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Retry-After", "60")
			w.WriteHeader(429)
		},
	} {
		t.Run(name, func(t *testing.T) {
			e := newEnv(t, allowAll, time.Minute, resilient)
			var calls atomic.Int32
			e.up.handler = func(w http.ResponseWriter, r *http.Request) { calls.Add(1); handler(w, r) }
			res := e.post("/v1/chat/completions", devKey, `{"model":"openai/gpt-4o"}`)
			if calls.Load() != 1 || res.StatusCode < 400 {
				t.Fatalf("status %d after %d calls, want the answer as is after 1", res.StatusCode, calls.Load())
			}
			if name == "429 asking for a long wait" && res.Header.Get("Retry-After") != "60" {
				t.Error("the provider's Retry-After must reach the client")
			}
		})
	}
}

func TestBrokenConnectionAfterTheRequestIsNotRetried(t *testing.T) {
	// The provider read the request and may be running it: sending it again
	// could run (and bill) it twice.
	e := newEnv(t, allowAll, time.Minute, resilient)
	var calls atomic.Int32
	e.up.handler = func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		c, _, _ := w.(http.Hijacker).Hijack()
		c.Close()
	}
	res := e.post("/v1/chat/completions", devKey, `{"model":"openai/gpt-4o"}`)
	if res.StatusCode != 502 || errCode(t, res) != "upstream_unreachable" || calls.Load() != 1 {
		t.Fatalf("status %d after %d calls, want 502 after 1", res.StatusCode, calls.Load())
	}
}

func TestOnlyConnectErrorsAreRetried(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr := ln.Addr().String()
	ln.Close() // nothing listens there now
	_, dialErr := http.Post("http://"+addr+"/", "application/json", strings.NewReader("{}"))
	if dialErr == nil {
		t.Skip("something answered on a closed port")
	}
	if failed, retryable, _ := classify(nil, dialErr); !failed || !retryable {
		t.Errorf("refused connection: failed=%v retryable=%v, want both", failed, retryable)
	}
	if failed, retryable, _ := classify(nil, io.ErrUnexpectedEOF); !failed || retryable {
		t.Errorf("broken connection: failed=%v retryable=%v, want failed and not retried", failed, retryable)
	}
}

func TestStreamsThatBreakAfterTheHeadersOpenTheBreaker(t *testing.T) {
	e := newEnv(t, allowAll, time.Minute, resilient)
	var calls atomic.Int32
	e.up.handler = func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		w.Header().Set("Content-Type", "text/event-stream")
		io.WriteString(w, "data: {\"choices\":[]}\n\n")
		w.(http.Flusher).Flush()
		c, _, _ := w.(http.Hijacker).Hijack()
		c.Close() // the stream breaks
	}
	for range 3 {
		res := e.post("/v1/chat/completions", devKey, `{"model":"openai/gpt-4o","stream":true}`)
		io.Copy(io.Discard, res.Body)
	}
	res := e.post("/v1/chat/completions", devKey, `{"model":"openai/gpt-4o","stream":true}`)
	if res.StatusCode != 503 || errCode(t, res) != "provider_unavailable" || calls.Load() != 3 {
		t.Fatalf("status %d after %d calls: three broken streams must open the breaker", res.StatusCode, calls.Load())
	}
}

func TestBreakerFailsFastWhileTheProviderIsDown(t *testing.T) {
	e := newEnv(t, allowAll, time.Minute, func(h *Handler) {
		resilient(h)
		h.Retry.Max = 0 // one call per request, to count them
	})
	var calls atomic.Int32
	down := atomic.Bool{}
	down.Store(true)
	e.up.handler = func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if down.Load() {
			w.WriteHeader(502)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, `{"id":"x","choices":[]}`)
	}
	for range 3 {
		e.post("/v1/chat/completions", devKey, `{"model":"openai/gpt-4o"}`)
	}
	res := e.post("/v1/chat/completions", devKey, `{"model":"openai/gpt-4o"}`)
	if res.StatusCode != 503 || errCode(t, res) != "provider_unavailable" || res.Header.Get("Retry-After") == "" {
		t.Fatalf("open breaker: status %d", res.StatusCode)
	}
	if calls.Load() != 3 {
		t.Fatalf("the open breaker must not call the provider: %d calls", calls.Load())
	}
	if e.m.BreakerRejections.Load() != 1 {
		t.Errorf("rejections metric = %d", e.m.BreakerRejections.Load())
	}

	down.Store(false)
	time.Sleep(250 * time.Millisecond) // the cooldown
	if res := e.post("/v1/chat/completions", devKey, `{"model":"openai/gpt-4o"}`); res.StatusCode != 200 {
		t.Fatalf("probe after the cooldown: %d", res.StatusCode)
	}
	if res := e.post("/v1/chat/completions", devKey, `{"model":"openai/gpt-4o"}`); res.StatusCode != 200 {
		t.Fatalf("closed again: %d", res.StatusCode)
	}
}

func TestRateLimitsDoNotOpenTheBreaker(t *testing.T) {
	e := newEnv(t, allowAll, time.Minute, func(h *Handler) {
		resilient(h)
		h.Retry.Max = 0
	})
	e.up.handler = func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(429) }
	for range 5 {
		if res := e.post("/v1/chat/completions", devKey, `{"model":"openai/gpt-4o"}`); res.StatusCode != 429 {
			t.Fatalf("status %d: a rate limit must not open the breaker", res.StatusCode)
		}
	}
}

func TestLineSplitterHandlesSplitsAndOverflow(t *testing.T) {
	var s lineSplitter
	var got []string
	fn := func(l []byte) { got = append(got, string(l)) }
	s.feed([]byte("data: a"), fn)
	s.feed([]byte("bc\r\ndata: d\n"), fn)
	s.feed([]byte(strings.Repeat("x", maxLine+10)), fn)
	s.feed([]byte("\nok\n"), fn)
	want := []string{"data: abc", "data: d", "ok"}
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Fatalf("got %q want %q", got, want)
	}
}
