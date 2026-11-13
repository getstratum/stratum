package proxy

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync/atomic"
	"syscall"
	"testing"
	"time"

	"github.com/getstratum/stratum/gateway/internal/auth"
	"github.com/getstratum/stratum/gateway/internal/snapshot"
)

const aliasAgentKey = "aig_agt_alias_fixed_test_000000"

// withAliases adds to an env a second OpenAI-compatible provider (groq,
// answered by its own server), an agent whose fixed model is an alias, and
// the organization's aliases. It returns the second upstream.
func withAliases(t *testing.T, e *env, aliases string) *upstream {
	t.Helper()
	up2 := &upstream{handler: func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, `{"id":"y","choices":[],"usage":{"prompt_tokens":5,"completion_tokens":3}}`)
	}}
	srv := httptest.NewServer(up2)
	t.Cleanup(srv.Close)
	delta := `{"current_version": 4,
	  "provider_configs": [{"id":"gq","provider":"groq","api_key":"gq-up","base_url":"` + srv.URL + `","enabled":true,"version":4,"revoked":false}],
	  "api_keys": [{"id":"agent:fx","key_hash":"` + auth.HashKey(aliasAgentKey) + `","team_id":"t1","version":4,"revoked":false,
	                "default_provider":"stratum","default_model":"rapido"}],
	  "model_aliases": ` + aliases + `}`
	var resp snapshot.SyncResponse
	if err := json.Unmarshal([]byte(delta), &resp); err != nil {
		t.Fatal(err)
	}
	st, err := e.h.Holder.State().Apply(&resp, false)
	if err != nil {
		t.Fatal(err)
	}
	e.h.Holder.Store(st, snapshot.Build(st, time.Now()))
	return up2
}

const rapido = `[{"name":"rapido","targets":[{"provider":"openai","model":"gpt-4o-mini"},{"provider":"groq","model":"llama-3.3-70b"}]},
                 {"name":"claude","targets":[{"provider":"anthropic","model":"claude-haiku-4-5"}]},
                 {"name":"mixto","targets":[{"provider":"anthropic","model":"claude-haiku-4-5"},{"provider":"groq","model":"llama-3.3-70b"}]}]`

func TestAliasGoesToItsFirstModel(t *testing.T) {
	e := newEnv(t, allowAll, time.Minute)
	up2 := withAliases(t, e, rapido)
	res := e.post("/v1/chat/completions", devKey, `{"model":"stratum/rapido","messages":[{"role":"user","content":"hola"}]}`)
	if res.StatusCode != 200 || res.Header.Get("X-Stratum-Routed-To") != "openai/gpt-4o-mini" {
		t.Fatalf("status %d, routed to %q", res.StatusCode, res.Header.Get("X-Stratum-Routed-To"))
	}
	if e.up.body["model"] != "gpt-4o-mini" || up2.body != nil {
		t.Errorf("first upstream got %v; second got %v", e.up.body["model"], up2.body)
	}
	got := e.usage.wait(t, 1)
	if len(got) != 1 || got[0].Provider != "openai" || got[0].Model != "gpt-4o-mini" || len(got[0].Labels) != 0 {
		t.Errorf("usage %+v", got)
	}
}

func TestAliasFallsBackWhileNothingReachedTheClient(t *testing.T) {
	e := newEnv(t, allowAll, time.Minute)
	up2 := withAliases(t, e, rapido)
	var calls atomic.Int32
	e.up.handler = func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		w.WriteHeader(http.StatusServiceUnavailable)
		io.WriteString(w, `{"error":{"message":"overloaded"}}`)
	}
	res := e.post("/v1/chat/completions", devKey, `{"model":"stratum/rapido","stream":true,"messages":[{"role":"user","content":"hola"}]}`)
	if res.StatusCode != 200 || res.Header.Get("X-Stratum-Routed-To") != "groq/llama-3.3-70b" {
		t.Fatalf("status %d, routed to %q", res.StatusCode, res.Header.Get("X-Stratum-Routed-To"))
	}
	if calls.Load() != 1 || up2.body["model"] != "llama-3.3-70b" || up2.body["stream_options"] == nil {
		t.Errorf("first called %d times; second got %v", calls.Load(), up2.body)
	}
	if up2.header.Get("Authorization") != "Bearer gq-up" {
		t.Errorf("second upstream auth %q", up2.header.Get("Authorization"))
	}
	got := e.usage.wait(t, 1)
	if len(got) != 1 || got[0].Provider != "groq" || got[0].Model != "llama-3.3-70b" ||
		strings.Join(got[0].Labels, ",") != "routed_fallback" {
		t.Errorf("usage %+v", got)
	}
	if e.m.AliasFallbacks.Load() != 1 {
		t.Errorf("fallbacks metric %d", e.m.AliasFallbacks.Load())
	}

	// A connection that broke after the request was written: the provider
	// may have run it, so it does not go on to another model.
	e.up.handler = func(w http.ResponseWriter, r *http.Request) {
		hj, _ := w.(http.Hijacker)
		c, _, _ := hj.Hijack()
		c.Close()
	}
	up2.body = nil
	if res := e.post("/v1/chat/completions", devKey, `{"model":"stratum/rapido"}`); res.StatusCode != 502 || up2.body != nil {
		t.Errorf("after a broken connection: %d, second got %v", res.StatusCode, up2.body)
	}
}

func TestAliasDoesNotFallBackOnTheRequestsOwnErrors(t *testing.T) {
	e := newEnv(t, allowAll, time.Minute)
	up2 := withAliases(t, e, rapido)
	e.up.handler = func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		io.WriteString(w, `{"error":{"message":"bad request"}}`)
	}
	res := e.post("/v1/chat/completions", devKey, `{"model":"stratum/rapido"}`)
	if res.StatusCode != 400 || up2.body != nil {
		t.Fatalf("status %d; second upstream got %v", res.StatusCode, up2.body)
	}
	// Every model fails: the client gets the last answer.
	e.up.handler = func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusServiceUnavailable) }
	up2.handler = func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusTooManyRequests) }
	if res := e.post("/v1/chat/completions", devKey, `{"model":"stratum/rapido"}`); res.StatusCode != 429 {
		t.Errorf("all failing: %d", res.StatusCode)
	}
}

func TestAliasFollowsThePolicy(t *testing.T) {
	onlyGroq := `{"id":"p","team_id":"t1","version":1,"allow_all_models":false,"allowed_models":["groq/llama-3.3-70b"],"pii_action":"redact","dlp_action":"block"}`
	e := newEnv(t, onlyGroq, time.Minute)
	up2 := withAliases(t, e, rapido)
	res := e.post("/v1/chat/completions", devKey, `{"model":"stratum/rapido"}`)
	if res.StatusCode != 200 || e.up.body != nil || up2.body["model"] != "llama-3.3-70b" {
		t.Fatalf("status %d; first got %v", res.StatusCode, e.up.body)
	}
	if res := e.post("/v1/chat/completions", devKey, `{"model":"stratum/claude"}`); res.StatusCode != 400 || errCode(t, res) != "alias_format_mismatch" {
		t.Errorf("an Anthropic alias on chat/completions: %d", res.StatusCode)
	}
	if res := e.post("/v1/messages", devKey, `{"model":"stratum/claude","max_tokens":10}`); res.StatusCode != 403 || errCode(t, res) != "model_not_allowed" {
		t.Errorf("nothing allowed: %d", res.StatusCode)
	}
	if res := e.post("/v1/chat/completions", devKey, `{"model":"stratum/lento"}`); res.StatusCode != 400 || errCode(t, res) != "unknown_alias" {
		t.Errorf("unknown alias: %d", res.StatusCode)
	}
	// An alias whose first model takes another format: the request's format decides.
	if res := e.post("/v1/chat/completions", devKey, `{"model":"stratum/mixto"}`); res.StatusCode != 200 || res.Header.Get("X-Stratum-Routed-To") != "groq/llama-3.3-70b" {
		t.Errorf("mixto: %d %q", res.StatusCode, res.Header.Get("X-Stratum-Routed-To"))
	}
}

func TestAgentWithAnAliasAsItsModel(t *testing.T) {
	e := newEnv(t, allowAll, time.Minute)
	withAliases(t, e, rapido)
	res := e.post("/v1/chat/completions", aliasAgentKey, `{"model":"lo-que-sea","messages":[]}`)
	if res.StatusCode != 200 || res.Header.Get("X-Stratum-Routed-To") != "openai/gpt-4o-mini" || e.up.body["model"] != "gpt-4o-mini" {
		t.Fatalf("status %d, routed to %q, model %v", res.StatusCode, res.Header.Get("X-Stratum-Routed-To"), e.up.body["model"])
	}
	// Its model list is the alias.
	req, _ := http.NewRequest(http.MethodGet, e.gw.URL+"/v1/models", nil)
	req.Header.Set("Authorization", "Bearer "+aliasAgentKey)
	r := httptest.NewRecorder()
	e.h.Models(r, req)
	if !strings.Contains(r.Body.String(), `"id":"stratum/rapido"`) || strings.Contains(r.Body.String(), "gpt-4o") {
		t.Errorf("models %s", r.Body)
	}
}

func TestModelsListAliasesTheCallerCanUse(t *testing.T) {
	onlyGroq := `{"id":"p","team_id":"t1","version":1,"allow_all_models":false,"allowed_models":["groq/llama-3.3-70b","openai/gpt-4o"],"pii_action":"redact","dlp_action":"block"}`
	e := newEnv(t, onlyGroq, time.Minute)
	withAliases(t, e, rapido)
	req, _ := http.NewRequest(http.MethodGet, e.gw.URL+"/v1/models", nil)
	req.Header.Set("Authorization", "Bearer "+devKey)
	r := httptest.NewRecorder()
	e.h.Models(r, req)
	var body struct {
		Data []struct{ ID string } `json:"data"`
	}
	json.Unmarshal(r.Body.Bytes(), &body)
	var ids []string
	for _, m := range body.Data {
		ids = append(ids, m.ID)
	}
	// Aliases first; "claude" has nothing this team may use.
	if strings.Join(ids, " ") != "stratum/mixto stratum/rapido groq/llama-3.3-70b openai/gpt-4o" {
		t.Errorf("models %v", ids)
	}
}

func TestFallsOver(t *testing.T) {
	for _, c := range []struct {
		res  *http.Response
		err  error
		want bool
	}{
		{nil, &breakerOpenError{}, true},
		{nil, &net.OpError{Op: "dial", Err: errors.New("connection refused")}, true},
		{nil, &net.DNSError{Err: "no such host"}, true},
		{nil, errors.New("read: connection reset by peer"), false}, // after the request was written
		{nil, context.Canceled, false},
		{&http.Response{StatusCode: 529}, nil, true},
		{&http.Response{StatusCode: 500}, nil, true},
		{&http.Response{StatusCode: 400}, nil, false},
		{&http.Response{StatusCode: 401}, nil, false},
		{&http.Response{StatusCode: 200}, nil, false},
	} {
		if got := fallsOver(c.res, c.err); got != c.want {
			t.Errorf("%v %v: %v", c.res, c.err, got)
		}
	}
}

// With a model to go to next, a provider that cannot be reached is not
// retried: the next model answers at once, without a backoff and a second
// wait to connect (found in the local test plan: 5 to 7 s per request).
func TestAliasDoesNotRetryAProviderItCannotReach(t *testing.T) {
	e := newEnv(t, allowAll, time.Minute, resilient)
	up2 := withAliases(t, e, rapido)
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	closed := "http://" + ln.Addr().String()
	ln.Close()
	var resp snapshot.SyncResponse
	if err := json.Unmarshal([]byte(`{"current_version": 5,
	  "provider_configs": [{"id":"ms","provider":"mistral","api_key":"ms-up","base_url":"`+closed+`","enabled":true,"version":5,"revoked":false}],
	  "model_aliases": [{"name":"caido","targets":[{"provider":"mistral","model":"small"},{"provider":"groq","model":"llama-3.3-70b"}]}]}`), &resp); err != nil {
		t.Fatal(err)
	}
	st, err := e.h.Holder.State().Apply(&resp, false)
	if err != nil {
		t.Fatal(err)
	}
	e.h.Holder.Store(st, snapshot.Build(st, time.Now()))
	var logs strings.Builder
	e.h.Log = slog.New(slog.NewTextHandler(&logs, nil))

	res := e.post("/v1/chat/completions", devKey, `{"model":"stratum/caido"}`)
	if res.StatusCode != 200 || res.Header.Get("X-Stratum-Routed-To") != "groq/llama-3.3-70b" || up2.body == nil {
		t.Fatalf("status %d, routed to %q", res.StatusCode, res.Header.Get("X-Stratum-Routed-To"))
	}
	if n := e.m.UpstreamRetries.Load(); n != 0 {
		t.Errorf("retried the unreachable provider %d times", n)
	}
	if !strings.Contains(logs.String(), "why=connection_refused") || !strings.Contains(logs.String(), "error=") {
		t.Errorf("log does not say why: %s", logs.String())
	}

	// The last model, with nowhere else to go, is still retried.
	e.up.handler = func(w http.ResponseWriter, r *http.Request) {}
	if res := e.post("/v1/chat/completions", devKey, `{"model":"mistral/small"}`); res.StatusCode != 502 || e.m.UpstreamRetries.Load() != 2 {
		t.Errorf("direct to the unreachable provider: %d after %d retries, want 502 after 2", res.StatusCode, e.m.UpstreamRetries.Load())
	}
}

func TestFallbackReason(t *testing.T) {
	for _, c := range []struct {
		res  *http.Response
		err  error
		want string
	}{
		{&http.Response{StatusCode: 503}, nil, "503"},
		{nil, &breakerOpenError{}, "paused"},
		{nil, &net.OpError{Op: "dial", Err: &net.DNSError{Err: "i/o timeout", IsTimeout: true}}, "dns_timeout"},
		{nil, &net.OpError{Op: "dial", Err: &net.DNSError{Err: "no such host", IsNotFound: true}}, "dns_error"},
		{nil, &net.OpError{Op: "dial", Err: os.NewSyscallError("connect", syscall.ECONNREFUSED)}, "connection_refused"},
		{nil, &net.OpError{Op: "dial", Err: context.DeadlineExceeded}, "connect_timeout"},
		{nil, &net.OpError{Op: "dial", Err: errors.New("network is unreachable")}, "connect_error"},
	} {
		if got := fallbackReason(c.res, c.err); got != c.want {
			t.Errorf("%v %v: %q, want %q", c.res, c.err, got, c.want)
		}
	}
}
