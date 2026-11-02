package proxy

import (
	"net/http"
	"strconv"
	"time"

	"github.com/getstratum/stratum/gateway/internal/trace"
	"github.com/getstratum/stratum/gateway/internal/usage"
)

// traceHeaders sets the W3C Trace Context of a request to the provider
// (ADR-0013). With traces on, the provider's parent is the gateway's client
// span; with them off, the client's own traceparent goes through as it
// came. Propagation off sends neither.
func (h *Handler) traceHeaders(up, in http.Header, rec *record) {
	if !h.Propagate {
		return
	}
	if h.Traces != nil {
		c := trace.SpanContext{TraceID: rec.span.TraceID, SpanID: rec.clientSpan, Sampled: rec.span.Sampled}
		up.Set("Traceparent", c.Traceparent())
		if rec.span.State != "" {
			up.Set("Tracestate", rec.span.State)
		}
		return
	}
	if rec.hasParent {
		up.Set("Traceparent", in.Get("Traceparent"))
		if rec.parent.State != "" {
			up.Set("Tracestate", rec.parent.State)
		}
	}
}

// exportSpans hands the request's spans to the exporter: the gateway's
// SERVER span, an INTERNAL one for the decision services, and a CLIENT one
// for the call to the provider, named and labelled as the OpenTelemetry
// GenAI conventions say. Only content-free attributes: never a prompt.
func (h *Handler) exportSpans(r *http.Request, rec *record) {
	if h.Traces == nil || !rec.span.Sampled {
		return
	}
	end := time.Now()

	server := trace.Span{
		Context: rec.span, Name: r.Method + " " + usage.Clip(r.URL.Path, 100), Kind: trace.KindServer,
		Start: rec.start, End: end,
		Attrs: []trace.Attr{
			{Key: "http.request.method", Value: r.Method},
			{Key: "url.path", Value: usage.Clip(r.URL.Path, 200)},
			{Key: "stratum.reason", Value: rec.reason},
		},
	}
	if rec.hasParent {
		server.Parent = rec.parent.SpanID
	}
	if rec.status > 0 {
		server.Attrs = append(server.Attrs, trace.Attr{Key: "http.response.status_code", Value: rec.status})
	}
	if rec.status >= 400 {
		server.Attrs = append(server.Attrs, trace.Attr{Key: "error.type", Value: rec.reason})
	}
	if rec.status >= 500 {
		server.Status, server.StatusMessage = trace.StatusError, rec.reason
	}
	if h.RequestID != nil {
		if id := h.RequestID(r.Context()); id != "" {
			server.Attrs = append(server.Attrs, trace.Attr{Key: "stratum.request_id", Value: usage.Clip(id, 128)})
		}
	}
	for _, a := range []trace.Attr{
		{Key: "stratum.team_id", Value: rec.teamID}, {Key: "stratum.key_id", Value: rec.keyID},
		{Key: "stratum.user_id", Value: rec.userID}, {Key: "stratum.task", Value: rec.task},
	} {
		if a.Value != "" {
			server.Attrs = append(server.Attrs, a)
		}
	}
	if len(rec.labels) > 0 {
		server.Attrs = append(server.Attrs, trace.Attr{Key: "stratum.labels", Value: rec.labels})
	}
	if len(rec.piiTypes) > 0 {
		server.Attrs = append(server.Attrs, trace.Attr{Key: "stratum.content_flags", Value: rec.piiTypes})
	}
	spans := []trace.Span{server}

	if rec.decResult != "" {
		d := trace.Span{
			Context: trace.SpanContext{TraceID: rec.span.TraceID, SpanID: rec.decSpan, Sampled: true, State: rec.span.State},
			Parent:  rec.span.SpanID, Name: "stratum.decision", Kind: trace.KindInternal,
			Start: rec.decStart, End: rec.decEnd,
			Attrs: []trace.Attr{{Key: "stratum.decision.result", Value: rec.decResult}},
		}
		if rec.decCode != "" {
			d.Attrs = append(d.Attrs, trace.Attr{Key: "stratum.decision.code", Value: rec.decCode})
		}
		spans = append(spans, d)
	}

	if rec.sent {
		upEnd := rec.upEnd
		if upEnd.IsZero() {
			upEnd = end
		}
		model := usage.Clip(rec.model, 100)
		c := trace.Span{
			Context: trace.SpanContext{TraceID: rec.span.TraceID, SpanID: rec.clientSpan, Sampled: true, State: rec.span.State},
			Parent:  rec.span.SpanID, Name: rec.operation + " " + model, Kind: trace.KindClient,
			Start: rec.upStart, End: upEnd,
			Attrs: []trace.Attr{
				{Key: "gen_ai.operation.name", Value: rec.operation},
				{Key: "gen_ai.provider.name", Value: usage.Clip(rec.provider, 50)},
				{Key: "gen_ai.request.model", Value: model},
				{Key: "stratum.attempts", Value: rec.attempts},
			},
		}
		if rec.upHost != "" {
			c.Attrs = append(c.Attrs, trace.Attr{Key: "server.address", Value: rec.upHost})
		}
		if rec.upStatus > 0 {
			c.Attrs = append(c.Attrs, trace.Attr{Key: "http.response.status_code", Value: rec.upStatus})
		}
		if rec.usage.Input > 0 || rec.usage.Output > 0 {
			c.Attrs = append(c.Attrs,
				trace.Attr{Key: "gen_ai.usage.input_tokens", Value: rec.usage.Input},
				trace.Attr{Key: "gen_ai.usage.output_tokens", Value: rec.usage.Output})
		}
		var errType string
		switch {
		case rec.reason == "upstream_status":
			errType = strconv.Itoa(rec.status) // as the GenAI metrics do
		case rec.reason != "ok":
			errType = rec.reason
		}
		if errType != "" {
			c.Attrs = append(c.Attrs, trace.Attr{Key: "error.type", Value: errType})
			c.Status, c.StatusMessage = trace.StatusError, errType
		}
		spans = append(spans, c)
	}
	h.Traces.Export(spans...)
}
