# ADR-0013: Traces from the gateway

- **Status:** Accepted (option B)
- **Date:** 2026-10-20; decided 2026-11-02

## Context

Operators who run OpenTelemetry want a request through Stratum to show up as
a span in their traces: from their application, through the gateway, to the
provider, with the time spent in each part. Today the gateway gives them:

- logs with a request ID per request (`X-Stratum-Request-Id`);
- Prometheus metrics, among them the GenAI client histograms
  (`gen_ai_client_operation_duration_seconds`, `gen_ai_client_token_usage`)
  in the OpenTelemetry semantic conventions' names;
- no spans, and the W3C `traceparent` header of the client is not forwarded
  to the provider (the gateway forwards a short list of headers).

ADR-0001 keeps the gateway on the Go standard library only. The OpenTelemetry
Go SDK with an OTLP exporter brings in the SDK, gRPC and protobuf: dozens of
modules on the request path's binary, each to follow for vulnerabilities, for
a feature only some operators use.

## Options

**A. The OpenTelemetry Go SDK.** Complete and maintained by the OpenTelemetry
project: spans, context propagation, sampling, batching, OTLP over gRPC or
HTTP. Breaks ADR-0001; the image and the dependency review grow for every
operator, whether they trace or not.

**B. A small OTLP/HTTP exporter in the standard library.** OTLP has a JSON
encoding over HTTP (`POST /v1/traces`, `ExportTraceServiceRequest`) that is
stable since OTLP 1.0. The gateway would:

1. read `traceparent`/`tracestate` from the client, or start a trace;
2. record one span per request (`gen_ai.client` conventions: operation,
   provider, request model, tokens, error type) and one child span for the
   call to the provider, with retries as events;
3. forward a `traceparent` with the child span's ID to the provider;
4. batch spans in memory and send them off the request path to
   `OTEL_EXPORTER_OTLP_ENDPOINT` (a collector), dropping and counting them
   when the buffer is full, like usage records (ADR-0009);
5. honour `OTEL_TRACES_SAMPLER` (`parentbased_traceidratio` and the
   always/never samplers).

About 500 lines and their tests. What it does not get: gRPC, the SDK's
processors and views, automatic instrumentation of other libraries (the
gateway has none).

**C. Propagation only.** Forward `traceparent` and `tracestate` to the
provider unchanged, and put the trace ID in the gateway's request log and in
the usage record. No spans from the gateway: the operator's collector can
make them from the logs, or join the client's span to the provider's. A few
lines.

## Decision

B, which includes C. The gateway has its own OTLP/HTTP exporter in the
standard library (`gateway/internal/trace`), on only when an endpoint is set;
without one it still passes the client's `traceparent` on (C). A stays out
unless ADR-0001 is revisited for other reasons.

- B keeps ADR-0001 and gives operators real spans for the gateway's own time
  (policy, PII scanning, the decision services of ADR-0014), which C cannot.
- The decision services made it worth doing now: their time and their
  answers belong in the request's trace, and a service can join it.

What was built, against the plan above:

- the client's `traceparent`/`tracestate` is read (any version, W3C rules),
  or a trace is started;
- one SERVER span per request, an INTERNAL span `stratum.decision` when the
  decision services are asked, and a CLIENT span for the call to the provider
  named and labelled as the GenAI conventions say (`{operation} {model}`,
  `gen_ai.*`, `server.address`, `error.type`);
- retries are an attribute of the CLIENT span (`stratum.attempts`), not
  events: the attempts are already counted in the metrics;
- the provider and the decision services get a `traceparent` with the
  gateway's span as parent;
- `OTEL_TRACES_SAMPLER` with `always_on`, `always_off`, `traceidratio` and
  their `parentbased_` forms (default `parentbased_always_on`, as the SDKs);
- the SDKs' variables for the endpoint, headers, timeout, resource and batch
  processor; `http/json` is the only protocol (a collector takes it on 4318);
- spans carry metadata only, never content, as usage records.

Details: [Traces](../architecture/traces.md).

## Consequences

- The exporter's queue (`OTEL_BSP_MAX_QUEUE_SIZE`, 2,048 spans) is a new place
  where data can be dropped: `stratum_trace_spans_dropped_total`, and the
  chart's `StratumGatewaySpansDropped` alert.
- `traceparent` reaches the provider by default, as it reaches any HTTP
  service the client calls. `STRATUM_TRACE_PROPAGATION=false` stops it, for
  the provider and the decision services alike; the gateway still records
  its spans.
- No gRPC, no protobuf, no metrics or logs over OTLP: metrics stay on
  `/metrics` (the collector's Prometheus receiver reads them).
