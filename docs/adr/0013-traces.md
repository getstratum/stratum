# ADR-0013: Traces from the gateway

- **Status:** Proposed
- **Date:** 2026-10-20

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

## Decision (proposed)

C now, B when an operator needs gateway spans; A only if ADR-0001 is
revisited for other reasons.

- C costs nothing and makes traces continue through Stratum where the
  provider supports them, without a dependency or a new failure mode.
- B keeps ADR-0001 and gives real spans, but it is code to maintain against
  a specification. It is worth it when someone asks for it, not before.
- Metrics already follow the GenAI conventions, so dashboards built for them
  work today.

To be decided by the maintainers; nothing is implemented yet.

## Consequences

- With C, the gateway's own time (policy checks, PII scanning, queueing) is
  visible only in its logs and in `gen_ai_client_operation_duration_seconds`,
  not as a span.
- With B, the exporter's buffer is a new place where data can be dropped; it
  gets a metric and an alert like the usage buffer.
- Either way, `traceparent` reaches the provider: a client that did not want
  its trace IDs sent to the provider loses that choice unless it is made
  configurable (`STRATUM_TRACE_PROPAGATION=off`).
