package proxy

import (
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/getstratum/stratum/gateway/internal/auth"
	"github.com/getstratum/stratum/gateway/internal/metrics"
	"github.com/getstratum/stratum/gateway/internal/quota"
	"github.com/getstratum/stratum/gateway/internal/snapshot"
)

const devKey = "aig_sk_eng_test1234567890"

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
}

func newEnv(t *testing.T, policyJSON string, idle time.Duration) *env {
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
	  "api_keys": [{"id":"u1","key_hash":%q,"team_id":"t1","version":1,"revoked":false}],
	  "provider_configs": [
	    {"id":"oa","provider":"openai","api_key":"sk-up","base_url":%q,"enabled":true,"version":2,"revoked":false},
	    {"id":"an","provider":"anthropic","api_key":"ak-up","base_url":%q,"enabled":true,"version":2,"revoked":false}
	  ]}`, policyJSON, auth.HashKey(devKey), upSrv.URL, upSrv.URL)
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

	e := &env{t: t, up: up, quota: quota.NewLocal(), m: metrics.New()}
	h := &Handler{
		Holder: holder, Quota: e.quota, Metrics: e.m,
		Log:               slog.New(slog.NewTextHandler(io.Discard, nil)),
		Client:            &http.Client{Transport: NewTransport(5 * time.Second)},
		MaxRequestBytes:   1 << 20,
		StreamIdleTimeout: idle,
		PIIEnabled:        true,
		UserAgent:         "stratum-gateway/test",
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
