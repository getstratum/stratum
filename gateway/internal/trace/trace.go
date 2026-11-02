// Package trace makes OpenTelemetry spans for the gateway's requests and
// sends them to a collector over OTLP/HTTP in JSON, with the standard
// library only (ADR-0013, option B).
//
// It reads the W3C Trace Context of the client (traceparent, tracestate),
// samples the way OTEL_TRACES_SAMPLER says, and batches finished spans in
// memory, off the request path, to OTEL_EXPORTER_OTLP_TRACES_ENDPOINT (or
// OTEL_EXPORTER_OTLP_ENDPOINT + /v1/traces). A full buffer drops spans and
// counts them, like usage records (ADR-0009).
package trace

import (
	"crypto/rand"
	"encoding/hex"
	"strings"
)

// SpanContext is a span's identity, as W3C Trace Context carries it.
type SpanContext struct {
	TraceID [16]byte
	SpanID  [8]byte
	Sampled bool
	State   string // tracestate, passed on unchanged
}

func (c SpanContext) Valid() bool { return c.TraceID != [16]byte{} && c.SpanID != [8]byte{} }

func (c SpanContext) TraceHex() string { return hex.EncodeToString(c.TraceID[:]) }
func (c SpanContext) SpanHex() string  { return hex.EncodeToString(c.SpanID[:]) }

// Traceparent is the header value for this span.
func (c SpanContext) Traceparent() string {
	flags := "00"
	if c.Sampled {
		flags = "01"
	}
	return "00-" + c.TraceHex() + "-" + c.SpanHex() + "-" + flags
}

// Parse reads traceparent (version 00, or a later version's first four
// fields) and tracestate. ok is false when there is no valid parent.
func Parse(traceparent, tracestate string) (SpanContext, bool) {
	p := strings.TrimSpace(traceparent)
	parts := strings.Split(p, "-")
	if len(parts) < 4 || len(parts[0]) != 2 || len(parts[1]) != 32 || len(parts[2]) != 16 || len(parts[3]) != 2 {
		return SpanContext{}, false
	}
	if parts[0] == "ff" || (parts[0] == "00" && len(parts) != 4) || !lowerHex(strings.Join(parts[:4], "-")) {
		return SpanContext{}, false
	}
	var c SpanContext
	if _, err := hex.Decode(c.TraceID[:], []byte(parts[1])); err != nil {
		return SpanContext{}, false
	}
	if _, err := hex.Decode(c.SpanID[:], []byte(parts[2])); err != nil {
		return SpanContext{}, false
	}
	var flags [1]byte
	if _, err := hex.Decode(flags[:], []byte(parts[3])); err != nil {
		return SpanContext{}, false
	}
	if !c.Valid() {
		return SpanContext{}, false
	}
	c.Sampled = flags[0]&1 == 1
	if s := strings.TrimSpace(tracestate); len(s) <= 512 && !strings.ContainsAny(s, "\r\n") {
		c.State = s
	}
	return c, true
}

func lowerHex(s string) bool {
	for _, r := range s {
		if !(r == '-' || r >= '0' && r <= '9' || r >= 'a' && r <= 'f') {
			return false
		}
	}
	return true
}

// NewSpanID is a random span ID.
func NewSpanID() (id [8]byte) {
	for id == [8]byte{} {
		rand.Read(id[:])
	}
	return id
}

func newTraceID() (id [16]byte) {
	for id == [16]byte{} {
		rand.Read(id[:])
	}
	return id
}

// Start is the context of the gateway's own span for a request: a child of
// the client's span when there is one, else the root of a new trace, and
// whether the sampler keeps it.
func Start(parent SpanContext, hasParent bool, s Sampler) SpanContext {
	c := SpanContext{SpanID: NewSpanID()}
	if hasParent {
		c.TraceID, c.State = parent.TraceID, parent.State
	} else {
		c.TraceID = newTraceID()
	}
	c.Sampled = s.Sample(parent, hasParent, c.TraceID)
	return c
}
