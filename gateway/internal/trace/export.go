package trace

import (
	"bytes"
	"context"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strconv"
	"sync"
	"sync/atomic"
	"time"
)

// Span kinds and status codes, as OTLP numbers them.
const (
	KindInternal = 1
	KindServer   = 2
	KindClient   = 3

	StatusUnset = 0
	StatusError = 2
)

// Attr is one attribute: a string, int64, bool, float64 or []string.
type Attr struct {
	Key   string
	Value any
}

// Event is something that happened during a span.
type Event struct {
	Name  string
	Time  time.Time
	Attrs []Attr
}

// Span is a finished span.
type Span struct {
	Context       SpanContext
	Parent        [8]byte // zero for a root span
	Name          string
	Kind          int
	Start, End    time.Time
	Attrs         []Attr
	Events        []Event
	Status        int
	StatusMessage string
}

// ExporterOptions configure an Exporter.
type ExporterOptions struct {
	Endpoint     string            // the full URL spans are POSTed to
	Headers      map[string]string // OTEL_EXPORTER_OTLP_HEADERS
	Resource     []Attr            // service.name and OTEL_RESOURCE_ATTRIBUTES
	ScopeVersion string
	Timeout      time.Duration // per export
	QueueSize    int           // spans kept in memory; past it new ones are dropped
	BatchSize    int           // spans per export
	Interval     time.Duration // how often the queue is sent
	HTTP         *http.Client
	Log          *slog.Logger
}

// Counters, read by the gateway's /metrics.
type Counters struct {
	Exported atomic.Int64
	Dropped  atomic.Int64 // queue full, or a batch the collector refused
	Failures atomic.Int64 // exports that failed
}

type Exporter struct {
	opts     ExporterOptions
	Counters Counters

	mu    sync.Mutex
	queue []Span
	kick  chan struct{}
}

func NewExporter(o ExporterOptions) *Exporter {
	if o.Timeout <= 0 {
		o.Timeout = 10 * time.Second
	}
	if o.QueueSize <= 0 {
		o.QueueSize = 2048
	}
	if o.BatchSize <= 0 || o.BatchSize > o.QueueSize {
		o.BatchSize = min(512, o.QueueSize)
	}
	if o.Interval <= 0 {
		o.Interval = 5 * time.Second
	}
	if o.HTTP == nil {
		o.HTTP = &http.Client{}
	}
	if o.Log == nil {
		o.Log = slog.New(slog.NewTextHandler(io.Discard, nil))
	}
	return &Exporter{opts: o, kick: make(chan struct{}, 1)}
}

// Export queues a finished span; never blocks.
func (e *Exporter) Export(spans ...Span) {
	e.mu.Lock()
	room := e.opts.QueueSize - len(e.queue)
	n := min(room, len(spans))
	e.queue = append(e.queue, spans[:n]...)
	full := len(e.queue) >= e.opts.BatchSize
	e.mu.Unlock()
	if dropped := len(spans) - n; dropped > 0 {
		e.Counters.Dropped.Add(int64(dropped))
	}
	if full {
		select {
		case e.kick <- struct{}{}:
		default:
		}
	}
}

// Queued is how many spans wait to be sent.
func (e *Exporter) Queued() int {
	e.mu.Lock()
	defer e.mu.Unlock()
	return len(e.queue)
}

// Run sends the queue every Interval, or sooner when a batch is full,
// until ctx ends.
func (e *Exporter) Run(ctx context.Context) {
	t := time.NewTicker(e.opts.Interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		case <-e.kick:
		}
		e.Flush(ctx)
	}
}

// Flush sends everything queued, in batches. A batch the collector does not
// take is dropped and counted: spans are not worth holding up the next.
func (e *Exporter) Flush(ctx context.Context) {
	for {
		e.mu.Lock()
		n := min(len(e.queue), e.opts.BatchSize)
		batch := append([]Span(nil), e.queue[:n]...)
		e.queue = e.queue[n:]
		e.mu.Unlock()
		if n == 0 {
			return
		}
		if err := e.send(ctx, batch); err != nil {
			e.Counters.Failures.Add(1)
			e.Counters.Dropped.Add(int64(n))
			e.opts.Log.Warn("could not export spans", "spans", n, "error", err)
			continue
		}
		e.Counters.Exported.Add(int64(n))
	}
}

func (e *Exporter) send(ctx context.Context, batch []Span) error {
	body, err := json.Marshal(e.encode(batch))
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(ctx, e.opts.Timeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, e.opts.Endpoint, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	for k, v := range e.opts.Headers {
		req.Header.Set(k, v)
	}
	res, err := e.opts.HTTP.Do(req)
	if err != nil {
		return err
	}
	io.Copy(io.Discard, io.LimitReader(res.Body, 64<<10))
	res.Body.Close()
	if res.StatusCode/100 != 2 {
		return fmt.Errorf("collector answered %d", res.StatusCode)
	}
	return nil
}

// ── OTLP/JSON (ExportTraceServiceRequest) ──────────────────────────────

type anyValue map[string]any
type keyValue struct {
	Key   string   `json:"key"`
	Value anyValue `json:"value"`
}

func value(v any) anyValue {
	switch x := v.(type) {
	case string:
		return anyValue{"stringValue": x}
	case bool:
		return anyValue{"boolValue": x}
	case int:
		return anyValue{"intValue": strconv.FormatInt(int64(x), 10)}
	case int64:
		return anyValue{"intValue": strconv.FormatInt(x, 10)}
	case float64:
		return anyValue{"doubleValue": x}
	case []string:
		vals := make([]anyValue, len(x))
		for i, s := range x {
			vals[i] = anyValue{"stringValue": s}
		}
		return anyValue{"arrayValue": map[string]any{"values": vals}}
	default:
		return anyValue{"stringValue": fmt.Sprint(x)}
	}
}

func attrs(as []Attr) []keyValue {
	out := make([]keyValue, 0, len(as))
	for _, a := range as {
		out = append(out, keyValue{Key: a.Key, Value: value(a.Value)})
	}
	return out
}

func nanos(t time.Time) string { return strconv.FormatInt(t.UnixNano(), 10) }

func (e *Exporter) encode(batch []Span) map[string]any {
	spans := make([]map[string]any, 0, len(batch))
	for _, s := range batch {
		j := map[string]any{
			"traceId": s.Context.TraceHex(), "spanId": s.Context.SpanHex(),
			"name": s.Name, "kind": s.Kind,
			"startTimeUnixNano": nanos(s.Start), "endTimeUnixNano": nanos(s.End),
			"attributes": attrs(s.Attrs),
			"status":     map[string]any{"code": s.Status, "message": s.StatusMessage},
		}
		if s.Parent != [8]byte{} {
			j["parentSpanId"] = hex.EncodeToString(s.Parent[:])
		}
		if s.Context.State != "" {
			j["traceState"] = s.Context.State
		}
		if len(s.Events) > 0 {
			evs := make([]map[string]any, len(s.Events))
			for i, ev := range s.Events {
				evs[i] = map[string]any{"name": ev.Name, "timeUnixNano": nanos(ev.Time), "attributes": attrs(ev.Attrs)}
			}
			j["events"] = evs
		}
		spans = append(spans, j)
	}
	return map[string]any{"resourceSpans": []map[string]any{{
		"resource": map[string]any{"attributes": attrs(e.opts.Resource)},
		"scopeSpans": []map[string]any{{
			"scope": map[string]any{"name": "stratum-gateway", "version": e.opts.ScopeVersion},
			"spans": spans,
		}},
	}}}
}
