package trace

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
)

const tp = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"

func TestParse(t *testing.T) {
	c, ok := Parse(tp, " vendor=x ")
	if !ok || c.TraceHex() != "4bf92f3577b34da6a3ce929d0e0e4736" || c.SpanHex() != "00f067aa0ba902b7" || !c.Sampled || c.State != "vendor=x" {
		t.Fatalf("%+v %v", c, ok)
	}
	if c.Traceparent() != tp {
		t.Errorf("round trip: %s", c.Traceparent())
	}
	// A later version may add fields; its first four are read.
	if c, ok := Parse("01-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-00-extra", ""); !ok || c.Sampled {
		t.Errorf("future version: %+v %v", c, ok)
	}
	for _, bad := range []string{
		"", "garbage",
		"ff-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",   // forbidden version
		"00-4BF92F3577B34DA6A3CE929D0E0E4736-00f067aa0ba902b7-01",   // upper case
		"00-00000000000000000000000000000000-00f067aa0ba902b7-01",   // zero trace
		"00-4bf92f3577b34da6a3ce929d0e0e4736-0000000000000000-01",   // zero span
		"00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01-x", // 00 has four fields
		"00-4bf92f3577b34da6a3ce929d0e0e473-00f067aa0ba902b7-01",    // short trace
		"00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-1",    // short flags
		"00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902bg-01",   // not hex
	} {
		if _, ok := Parse(bad, ""); ok {
			t.Errorf("accepted %q", bad)
		}
	}
	if c, _ := Parse(tp, "a=1\r\nX-Evil: 1"); c.State != "" {
		t.Errorf("tracestate with a line break kept: %q", c.State)
	}
	if c, _ := Parse(tp, strings.Repeat("a", 513)); c.State != "" {
		t.Error("oversized tracestate kept")
	}
}

func TestStart(t *testing.T) {
	parent, _ := Parse(tp, "v=1")
	on, _ := ParseSampler("", "")
	c := Start(parent, true, on)
	if c.TraceID != parent.TraceID || c.SpanID == parent.SpanID || !c.Sampled || c.State != "v=1" {
		t.Errorf("child: %+v", c)
	}
	root := Start(SpanContext{}, false, on)
	if !root.Valid() || root.TraceID == parent.TraceID || !root.Sampled {
		t.Errorf("root: %+v", root)
	}
}

func TestSampler(t *testing.T) {
	for _, bad := range [][2]string{{"jaeger_remote", ""}, {"traceidratio", "2"}, {"traceidratio", "x"}} {
		if _, err := ParseSampler(bad[0], bad[1]); err == nil {
			t.Errorf("accepted %v", bad)
		}
	}
	sampled, _ := Parse(tp, "")
	unsampled, _ := Parse(strings.TrimSuffix(tp, "01")+"00", "")
	var id [16]byte

	pb, _ := ParseSampler("parentbased_always_on", "")
	if !pb.Sample(sampled, true, id) || pb.Sample(unsampled, true, id) || !pb.Sample(SpanContext{}, false, id) {
		t.Error("parentbased_always_on does not follow the parent")
	}
	on, _ := ParseSampler("ALWAYS_ON", "")
	off, _ := ParseSampler("always_off", "")
	if !on.Sample(unsampled, true, id) || off.Sample(sampled, true, id) {
		t.Error("always_on / always_off")
	}
	zero, _ := ParseSampler("traceidratio", "0")
	one, _ := ParseSampler("traceidratio", "1")
	half, _ := ParseSampler("parentbased_traceidratio", "0.5")
	other, _ := ParseSampler("traceidratio", "0.5") // another service, same ratio
	kept := 0
	for range 4000 {
		id := newTraceID()
		if zero.Sample(SpanContext{}, false, id) || !one.Sample(SpanContext{}, false, id) {
			t.Fatal("ratio 0 or 1")
		}
		if half.Sample(SpanContext{}, false, id) {
			kept++
		}
		// Every service with the same ratio decides the same for the same trace.
		if half.Sample(SpanContext{}, false, id) != other.Sample(SpanContext{}, false, id) {
			t.Fatal("not deterministic")
		}
	}
	if kept < 1700 || kept > 2300 {
		t.Errorf("ratio 0.5 kept %d of 4000", kept)
	}
}

// collector is a fake OTLP/HTTP receiver.
type collector struct {
	mu      sync.Mutex
	status  int
	bodies  []map[string]any
	headers []http.Header
}

func (c *collector) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	raw, _ := io.ReadAll(r.Body)
	var b map[string]any
	json.Unmarshal(raw, &b)
	c.mu.Lock()
	c.bodies = append(c.bodies, b)
	c.headers = append(c.headers, r.Header.Clone())
	status := c.status
	c.mu.Unlock()
	if status == 0 {
		status = 200
	}
	w.WriteHeader(status)
}

func span(name string) Span {
	c := Start(SpanContext{}, false, Sampler{Name: "always_on"})
	now := time.Unix(1700000000, 5)
	return Span{Context: c, Name: name, Kind: KindClient, Start: now, End: now.Add(time.Second),
		Attrs:  []Attr{{"s", "x"}, {"i", int64(42)}, {"n", 7}, {"b", true}, {"f", 0.5}, {"l", []string{"a", "b"}}},
		Status: StatusError, StatusMessage: "boom"}
}

func TestExporterSendsOTLPJSON(t *testing.T) {
	col := &collector{}
	srv := httptest.NewServer(col)
	defer srv.Close()
	e := NewExporter(ExporterOptions{Endpoint: srv.URL + "/v1/traces", Headers: map[string]string{"Authorization": "Bearer t"},
		Resource: []Attr{{"service.name", "stratum-gateway"}}, ScopeVersion: "1.2.3", BatchSize: 2, QueueSize: 10})
	s := span("chat gpt-4o")
	s.Parent = [8]byte{1}
	e.Export(s, span("b"), span("c"))
	e.Flush(context.Background())

	if len(col.bodies) != 2 || e.Counters.Exported.Load() != 3 || e.Queued() != 0 {
		t.Fatalf("%d posts, %d exported", len(col.bodies), e.Counters.Exported.Load())
	}
	if col.headers[0].Get("Authorization") != "Bearer t" || col.headers[0].Get("Content-Type") != "application/json" {
		t.Errorf("headers %v", col.headers[0])
	}
	rs := col.bodies[0]["resourceSpans"].([]any)[0].(map[string]any)
	if a := rs["resource"].(map[string]any)["attributes"].([]any)[0].(map[string]any); a["key"] != "service.name" {
		t.Errorf("resource %v", a)
	}
	ss := rs["scopeSpans"].([]any)[0].(map[string]any)
	if sc := ss["scope"].(map[string]any); sc["name"] != "stratum-gateway" || sc["version"] != "1.2.3" {
		t.Errorf("scope %v", sc)
	}
	got := ss["spans"].([]any)[0].(map[string]any)
	if got["traceId"] != s.Context.TraceHex() || got["spanId"] != s.Context.SpanHex() || got["parentSpanId"] != "0100000000000000" ||
		got["name"] != "chat gpt-4o" || got["kind"] != float64(KindClient) ||
		got["startTimeUnixNano"] != "1700000000000000005" || got["endTimeUnixNano"] != "1700000001000000005" {
		t.Errorf("span %v", got)
	}
	if st := got["status"].(map[string]any); st["code"] != float64(StatusError) || st["message"] != "boom" {
		t.Errorf("status %v", st)
	}
	vals := map[string]any{}
	for _, a := range got["attributes"].([]any) {
		kv := a.(map[string]any)
		vals[kv["key"].(string)] = kv["value"]
	}
	want := map[string]string{
		"s": `{"stringValue":"x"}`, "i": `{"intValue":"42"}`, "n": `{"intValue":"7"}`, "b": `{"boolValue":true}`,
		"f": `{"doubleValue":0.5}`, "l": `{"arrayValue":{"values":[{"stringValue":"a"},{"stringValue":"b"}]}}`,
	}
	for k, w := range want {
		if b, _ := json.Marshal(vals[k]); string(b) != w {
			t.Errorf("%s = %s, want %s", k, b, w)
		}
	}
	if _, ok := col.bodies[1]["resourceSpans"].([]any)[0].(map[string]any)["scopeSpans"].([]any)[0].(map[string]any)["spans"].([]any)[0].(map[string]any)["parentSpanId"]; ok {
		t.Error("root span has a parentSpanId")
	}
}

func TestExporterDropsWhenFullOrRefused(t *testing.T) {
	col := &collector{status: 500}
	srv := httptest.NewServer(col)
	defer srv.Close()
	e := NewExporter(ExporterOptions{Endpoint: srv.URL, QueueSize: 3, BatchSize: 3})
	e.Export(span("a"), span("b"), span("c"), span("d"), span("e"))
	if e.Queued() != 3 || e.Counters.Dropped.Load() != 2 {
		t.Fatalf("queued %d, dropped %d", e.Queued(), e.Counters.Dropped.Load())
	}
	e.Flush(context.Background())
	if e.Queued() != 0 || e.Counters.Dropped.Load() != 5 || e.Counters.Failures.Load() != 1 || e.Counters.Exported.Load() != 0 {
		t.Errorf("after refusal: queued %d dropped %d failures %d", e.Queued(), e.Counters.Dropped.Load(), e.Counters.Failures.Load())
	}
}

func TestExporterRunSendsAFullBatchAtOnce(t *testing.T) {
	col := &collector{}
	srv := httptest.NewServer(col)
	defer srv.Close()
	e := NewExporter(ExporterOptions{Endpoint: srv.URL, QueueSize: 10, BatchSize: 2, Interval: time.Hour})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go e.Run(ctx)
	e.Export(span("a"), span("b"))
	deadline := time.Now().Add(2 * time.Second)
	for e.Counters.Exported.Load() < 2 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if e.Counters.Exported.Load() != 2 {
		t.Fatalf("exported %d", e.Counters.Exported.Load())
	}
}
