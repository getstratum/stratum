# Traces

The gateway can send OpenTelemetry spans for each request to a collector, so
a call through Stratum shows up in your traces: from your application,
through the gateway's checks and the decision services, to the provider. Why
it works this way: [ADR-0013](../adr/0013-traces.md).

## Turning it on

Point the gateway at the OTLP/HTTP port of an OpenTelemetry Collector (or any
backend that takes OTLP over HTTP in JSON):

```sh
OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4318
```

The gateway reads the OpenTelemetry SDKs' variables, with the same meaning:

| Variable | Default | |
|---|---|---|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | | Base URL; the gateway posts to `{base}/v1/traces`. |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | | Full URL, used as is; wins over the base. |
| `OTEL_EXPORTER_OTLP_PROTOCOL`, `OTEL_EXPORTER_OTLP_TRACES_PROTOCOL` | `http/json` | Only `http/json`: the gateway has no gRPC or protobuf (ADR-0001). Anything else refuses to start. |
| `OTEL_EXPORTER_OTLP_HEADERS`, `OTEL_EXPORTER_OTLP_TRACES_HEADERS` | | `key=value,key2=value2`, values percent-encoded: `Authorization=Bearer%20<token>`. |
| `OTEL_EXPORTER_OTLP_TIMEOUT`, `OTEL_EXPORTER_OTLP_TRACES_TIMEOUT` | `10000` | Per export, in milliseconds. |
| `OTEL_TRACES_SAMPLER` / `OTEL_TRACES_SAMPLER_ARG` | `parentbased_always_on` | `always_on`, `always_off`, `traceidratio` (ratio 0 to 1) and their `parentbased_` forms. |
| `OTEL_SERVICE_NAME` | `stratum-gateway` | The `service.name` resource attribute. |
| `OTEL_RESOURCE_ATTRIBUTES` | | More resource attributes: `deployment.environment=prod,cloud.region=southamerica-east1`. |
| `OTEL_BSP_MAX_QUEUE_SIZE` / `OTEL_BSP_MAX_EXPORT_BATCH_SIZE` / `OTEL_BSP_SCHEDULE_DELAY` | `2048` / `512` / `5000` | Spans kept in memory, spans per export, and milliseconds between exports. |
| `OTEL_TRACES_EXPORTER` | `otlp` | `none` turns spans off even with an endpoint set. |
| `STRATUM_TRACE_PROPAGATION` | `true` | Whether the provider and the decision services get a `traceparent` (below). |

In the chart: `traces.endpoint`, `traces.sampler`, `traces.samplerArg`,
`traces.serviceName`, `traces.resourceAttributes`, `traces.headersSecret`
(a Secret with `OTEL_EXPORTER_OTLP_HEADERS`, for a backend that needs a
token) and `traces.propagation`; the other variables through `extraEnv`.

## What each request records

Every request, refused ones included, gives a **SERVER**
span `POST {path}`. With a valid `traceparent` from the client it is a child
of the client's span, in the same trace; without one it starts a trace.

| Attribute | |
|---|---|
| `http.request.method`, `url.path`, `http.response.status_code` | The request as the gateway got it, and what it answered. |
| `stratum.reason` | The gateway's short code: `ok`, `quota_exceeded`, `pii_blocked`, `upstream_status`, ... |
| `error.type` | The same code, when the answer is 4xx or 5xx. A 5xx marks the span as an error. |
| `stratum.team_id`, `stratum.key_id`, `stratum.user_id` | Whose request it was (ids, as in the usage records). |
| `stratum.task`, `stratum.labels`, `stratum.content_flags` | `X-Stratum-Task`, `X-Stratum-Labels` and the PII/DLP types found. |
| `stratum.request_id` | The `X-Stratum-Request-Id` of the answer, to find the request in the logs. |

When the [decision services](decision-services.md) are asked, an
**INTERNAL** span `stratum.decision` covers the check, with
`stratum.decision.result` (`allow`, `deny` or `skipped`) and, on a deny,
`stratum.decision.code`.

When the request goes to the provider, a **CLIENT** span named as the GenAI
conventions say, `{operation} {model}` (`chat gpt-4o-mini`), covers the call,
from the first try to the last byte of the answer or the stream:

| Attribute | |
|---|---|
| `gen_ai.operation.name`, `gen_ai.provider.name`, `gen_ai.request.model` | As in the `gen_ai_*` metrics. |
| `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens` | When the provider reported them. |
| `server.address`, `http.response.status_code` | The provider's host, and its status when it answered. |
| `error.type` | The provider's HTTP status, or the gateway's reason (`upstream_timeout`, `stream_idle_timeout`, ...). Marks the span as an error. |
| `stratum.attempts` | Tries, retries included (ADR-0010). |

Spans carry metadata only. Neither the prompt nor the answer, nor any part of
them, is ever put in a span.

The request log line gets `trace_id`, so a span leads to the log and back.

## Propagation

With traces on, the gateway sends the provider a `traceparent` whose parent
is its CLIENT span, and the decision services one whose parent is the
`stratum.decision` span; `tracestate` goes on as the client sent it. A
provider or a decision service that traces joins the trace.

With traces off, the client's own `traceparent` and `tracestate` go to the
provider unchanged; the gateway invents none.

`STRATUM_TRACE_PROPAGATION=false` sends no `traceparent` at all, for clients
that do not want their trace IDs to leave the network. The gateway still
records its spans.

## Sampling

The default, `parentbased_always_on`, does what the client decided: a
`traceparent` with the sampled flag off gives no spans, and requests without
one are all traced. For a busy gateway without traced clients,
`parentbased_traceidratio` with `OTEL_TRACES_SAMPLER_ARG=0.1` keeps one in ten
new traces and still follows the clients'. The ratio is decided on the trace
ID, as the SDKs do, so every service that uses the same rule keeps the same
traces.

## Watching it

Spans leave the request path: they go to a queue in memory and are sent in
batches. If the collector is down or slow, the queue fills and new spans are
dropped and counted; requests are never slowed or refused because of it.

| Metric | |
|---|---|
| `stratum_trace_spans_exported_total` | Spans the collector took. |
| `stratum_trace_spans_dropped_total` | Spans lost: the queue was full, or the collector did not take a batch. |
| `stratum_trace_export_failures_total` | Exports that failed. |
| `stratum_trace_spans_queued` | Spans waiting to be sent. |

The chart's `StratumGatewaySpansDropped` alert fires when spans are dropped.
On shutdown the gateway sends what is left, for up to 5 seconds.

## What it does not do

No OTLP over gRPC or protobuf, no metrics or logs over OTLP (scrape
`/metrics`; the collector's Prometheus receiver can), no span links or
baggage. Those need the OpenTelemetry SDK, which ADR-0001 keeps out of the
gateway.
