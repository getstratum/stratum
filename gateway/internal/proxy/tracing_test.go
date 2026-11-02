package proxy

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/getstratum/stratum/gateway/internal/decision"
	"github.com/getstratum/stratum/gateway/internal/trace"
)

const clientTP = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"

// otlp is a fake collector that keeps the spans it gets, by name.
type otlp struct {
	mu    sync.Mutex
	spans []map[string]any
}

func (o *otlp) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	var b struct {
		ResourceSpans []struct {
			ScopeSpans []struct {
				Spans []map[string]any `json:"spans"`
			} `json:"scopeSpans"`
		} `json:"resourceSpans"`
	}
	raw, _ := io.ReadAll(r.Body)
	json.Unmarshal(raw, &b)
	o.mu.Lock()
	for _, rs := range b.ResourceSpans {
		for _, ss := range rs.ScopeSpans {
			o.spans = append(o.spans, ss.Spans...)
		}
	}
	o.mu.Unlock()
}

// traced turns traces on for an env and returns a function that waits for
// n spans, sends them and returns them by kind.
func traced(t *testing.T, sampler string) (func(*Handler), func(n int) map[float64]map[string]any) {
	col := &otlp{}
	srv := httptest.NewServer(col)
	t.Cleanup(srv.Close)
	exp := trace.NewExporter(trace.ExporterOptions{Endpoint: srv.URL, Interval: time.Hour})
	s, err := trace.ParseSampler(sampler, "")
	if err != nil {
		t.Fatal(err)
	}
	configure := func(h *Handler) { h.Traces, h.Sampler, h.Propagate = exp, s, true }
	spans := func(n int) map[float64]map[string]any {
		t.Helper()
		deadline := time.Now().Add(2 * time.Second)
		for exp.Queued() < n && time.Now().Before(deadline) {
			time.Sleep(5 * time.Millisecond)
		}
		exp.Flush(context.Background())
		col.mu.Lock()
		defer col.mu.Unlock()
		if len(col.spans) != n {
			t.Fatalf("%d spans, want %d", len(col.spans), n)
		}
		out := map[float64]map[string]any{}
		for _, s := range col.spans {
			out[s["kind"].(float64)] = s
		}
		return out
	}
	return configure, spans
}

func attrsOf(span map[string]any) map[string]string {
	out := map[string]string{}
	for _, a := range span["attributes"].([]any) {
		kv := a.(map[string]any)
		for _, v := range kv["value"].(map[string]any) {
			b, _ := json.Marshal(v)
			out[kv["key"].(string)] = strings.Trim(string(b), `"`)
		}
	}
	return out
}

func TestTracesFollowTheClientAndTheGenAIConventions(t *testing.T) {
	on, spans := traced(t, "")
	d := &decider{answer: decision.Decision{Allow: true}}
	e := newEnv(t, allowAll, time.Minute, on, func(h *Handler) { h.Decision = d })

	res := e.postWith("/v1/chat/completions", agentKey, chat,
		map[string]string{"Traceparent": clientTP, "Tracestate": "vendor=1", "X-Stratum-Task": "ticket-42"})
	if res.StatusCode != 200 {
		t.Fatalf("status %d", res.StatusCode)
	}
	got := spans(3)
	server, client, dec := got[trace.KindServer], got[trace.KindClient], got[trace.KindInternal]

	// The client's trace goes on, with the gateway's span in between.
	if server["traceId"] != "4bf92f3577b34da6a3ce929d0e0e4736" || server["parentSpanId"] != "00f067aa0ba902b7" ||
		server["name"] != "POST /v1/chat/completions" || server["traceState"] != "vendor=1" {
		t.Errorf("server span %v", server)
	}
	if client["parentSpanId"] != server["spanId"] || dec["parentSpanId"] != server["spanId"] || dec["name"] != "stratum.decision" {
		t.Errorf("children: client %v decision %v", client["parentSpanId"], dec)
	}
	// The provider sees the gateway's client span as its parent.
	e.up.mu.Lock()
	upTP, upTS := e.up.header.Get("Traceparent"), e.up.header.Get("Tracestate")
	e.up.mu.Unlock()
	if upTP != "00-4bf92f3577b34da6a3ce929d0e0e4736-"+client["spanId"].(string)+"-01" || upTS != "vendor=1" {
		t.Errorf("provider got traceparent %q tracestate %q", upTP, upTS)
	}

	sa := attrsOf(server)
	if sa["http.response.status_code"] != "200" || sa["stratum.key_id"] != "agent:a1" || sa["stratum.team_id"] != "t1" ||
		sa["stratum.task"] != "ticket-42" || sa["stratum.reason"] != "ok" {
		t.Errorf("server attributes %v", sa)
	}
	ca := attrsOf(client)
	if client["name"] != "chat gpt-4o-mini" || ca["gen_ai.operation.name"] != "chat" || ca["gen_ai.provider.name"] != "openai" ||
		ca["gen_ai.request.model"] != "gpt-4o-mini" || ca["gen_ai.usage.input_tokens"] != "11" || ca["gen_ai.usage.output_tokens"] != "7" ||
		ca["server.address"] != "127.0.0.1" || ca["stratum.attempts"] != "1" || ca["error.type"] != "" {
		t.Errorf("client span %v %v", client["name"], ca)
	}
	if da := attrsOf(dec); da["stratum.decision.result"] != "allow" {
		t.Errorf("decision attributes %v", da)
	}
	// The decision services' spans can join the trace under the gateway's.
	if tp := d.checks[0].Traceparent; tp != "00-4bf92f3577b34da6a3ce929d0e0e4736-"+dec["spanId"].(string)+"-01" {
		t.Errorf("decision services got traceparent %q", tp)
	}
	// Never the prompt.
	for _, s := range got {
		if b, _ := json.Marshal(s); strings.Contains(string(b), "hola") {
			t.Errorf("a span carries the prompt: %s", b)
		}
	}
}

func TestTracesOfARefusalAndOfAProviderError(t *testing.T) {
	on, spans := traced(t, "always_on")
	e := newEnv(t, allowAll, time.Minute, on)
	e.up.handler = func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(503) }

	res := e.post("/v1/chat/completions", agentKey, chat)
	if res.StatusCode != 503 {
		t.Fatalf("status %d", res.StatusCode)
	}
	got := spans(2) // a root trace: no traceparent from the client
	server, client := got[trace.KindServer], got[trace.KindClient]
	if _, ok := server["parentSpanId"]; ok {
		t.Error("root span with a parent")
	}
	if a := attrsOf(client); a["error.type"] != "503" || a["http.response.status_code"] != "503" {
		t.Errorf("client %v", a)
	}
	if st := server["status"].(map[string]any); st["code"] != float64(trace.StatusError) {
		t.Errorf("server status %v", st)
	}

	// Refused before the provider: only the gateway's span.
	res = e.post("/v1/chat/completions", "aig_sk_wrong_000000000000", chat)
	if res.StatusCode != 401 {
		t.Fatalf("status %d", res.StatusCode)
	}
	refused := attrsOf(spans(3)[trace.KindServer]) // the latest server span
	if refused["http.response.status_code"] != "401" || refused["error.type"] == "" || refused["stratum.key_id"] != "" {
		t.Errorf("refusal %v", refused)
	}
}

func TestUnsampledParentMeansNoSpans(t *testing.T) {
	on, _ := traced(t, "parentbased_always_on")
	e := newEnv(t, allowAll, time.Minute, on)
	res := e.postWith("/v1/chat/completions", agentKey, chat, map[string]string{"Traceparent": strings.TrimSuffix(clientTP, "01") + "00"})
	if res.StatusCode != 200 {
		t.Fatalf("status %d", res.StatusCode)
	}
	time.Sleep(50 * time.Millisecond)
	if n := e.h.Traces.Queued(); n != 0 {
		t.Errorf("%d spans queued for an unsampled trace", n)
	}
	e.up.mu.Lock()
	defer e.up.mu.Unlock()
	if tp := e.up.header.Get("Traceparent"); !strings.HasPrefix(tp, "00-4bf92f3577b34da6a3ce929d0e0e4736-") || !strings.HasSuffix(tp, "-00") {
		t.Errorf("provider got %q", tp)
	}
}

func TestTraceparentWithoutTraces(t *testing.T) {
	e := newEnv(t, allowAll, time.Minute, func(h *Handler) { h.Propagate = true })
	e.postWith("/v1/chat/completions", agentKey, chat, map[string]string{"Traceparent": clientTP, "Tracestate": "v=1"})
	e.up.mu.Lock()
	tp, ts := e.up.header.Get("Traceparent"), e.up.header.Get("Tracestate")
	e.up.mu.Unlock()
	if tp != clientTP || ts != "v=1" {
		t.Errorf("passed through: %q %q", tp, ts)
	}
	e.post("/v1/chat/completions", agentKey, chat)
	e.up.mu.Lock()
	tp = e.up.header.Get("Traceparent")
	e.up.mu.Unlock()
	if tp != "" {
		t.Errorf("invented a traceparent: %q", tp)
	}
}

func TestPropagationOff(t *testing.T) {
	on, spans := traced(t, "")
	e := newEnv(t, allowAll, time.Minute, on, func(h *Handler) { h.Propagate = false })
	e.postWith("/v1/chat/completions", agentKey, chat, map[string]string{"Traceparent": clientTP})
	e.up.mu.Lock()
	tp := e.up.header.Get("Traceparent")
	e.up.mu.Unlock()
	if tp != "" {
		t.Errorf("provider got %q", tp)
	}
	spans(2) // the gateway still records its own
}

func TestMalformedTaskIsOnlyRefusedByDecisionServices(t *testing.T) {
	on, spans := traced(t, "")
	e := newEnv(t, allowAll, time.Minute, on)
	res := e.postWith("/v1/chat/completions", agentKey, chat, map[string]string{"X-Stratum-Task": "no spaces allowed"})
	if res.StatusCode != 200 {
		t.Fatalf("status %d", res.StatusCode)
	}
	if a := attrsOf(spans(2)[trace.KindServer]); a["stratum.task"] != "" {
		t.Errorf("malformed task kept: %v", a["stratum.task"])
	}
}
