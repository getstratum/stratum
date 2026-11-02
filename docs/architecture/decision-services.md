# Decision services

The gateway can ask external services whether a request may go to the
provider, and then tell them how it ended. Why it works this way:
[ADR-0014](../adr/0014-decision-services.md). This page is the protocol, for
anyone who writes one.

## Turning it on

| Variable | Default | |
|---|---|---|
| `STRATUM_DECISION_URLS` | | Up to four base URLs, comma-separated (`http://guard:8090,https://other.svc`). |
| `STRATUM_DECISION_TIMEOUT` | `200ms` | How long the gateway waits for all of them together, per request (10 ms to 5 s). |
| `STRATUM_DECISION_FAIL` | `open` | `open`: a service that does not answer, or answers wrong, is skipped and the request goes, labelled `decision_skipped`. `closed`: the request is refused with 503 `decision_unavailable`. |
| `STRATUM_DECISION_TOKEN` | | Sent to every service as `Authorization: Bearer <token>`. |

In the chart: `decision.urls`, `decision.timeout`, `decision.failMode` and
`decision.tokenSecret` (a Secret with the token).

Run the services on the same network as the gateway, and close them to
anything else.

## `POST /v1/check`

The gateway calls this after its own checks (key, policy, quota, PII/DLP)
and before it sends the request to the provider. It calls every service at
once.

```json
{
  "v": 1,
  "request_id": "req_01J…",
  "time": "2026-11-02T14:03:11.204Z",
  "key_id": "agent:7b0c…",
  "key_label": "triage-bot",
  "team_id": "2000…0001",
  "user_id": "",
  "task": "ticket-4812",
  "provider": "openai",
  "model": "gpt-4o-mini",
  "operation": "chat",
  "stream": true,
  "labels": ["support"],
  "content_sha256": "9f2c…",
  "content_bytes": 1824
}
```

| Field | |
|---|---|
| `key_id`, `key_label` | The key or agent that made the request. |
| `user_id` | The person a key that acts for people acted for (`X-Stratum-User`), if any. |
| `task` | `X-Stratum-Task` from the application: 1 to 100 letters, digits and `. _ : -`. A malformed one is refused before the services are asked (400 `invalid_task`). Without decision services the header is ignored. |
| `provider`, `model`, `operation` | Where the request goes, after routing and any fixed model of the agent. `operation` is `gen_ai.operation.name` (`chat`, `embeddings`…). |
| `labels` | The application's `X-Stratum-Labels`. |
| `content_sha256` | SHA-256 of what is asked: the `messages`, `prompt`, `input`, `system`, `instructions` or `contents` fields, encoded as JSON with sorted keys. It does not depend on the model, the sampling settings or the order of the keys. Two identical requests have the same hash. |
| `content_bytes` | Size of the body that goes to the provider. |

The text never leaves the gateway through this protocol.

### The answer

The service answers 200 with:

```json
{ "decision": "allow", "labels": ["loop_watch"], "headers": { "X-Stratum-Task-Budget-Left": "0.42" } }
```

or

```json
{ "decision": "deny", "status": 429, "code": "agent_loop",
  "message": "El agente repitió el mismo pedido 20 veces en un minuto.",
  "headers": { "Retry-After": "60" } }
```

The gateway keeps what is answered within bounds:

| Field | Rule |
|---|---|
| `status` | 400–599. Anything else becomes 403. |
| `code` | Lowercase letters, digits and `_`, starting with a letter, up to 50 characters. Anything else becomes `denied_by_decision_service`. |
| `message` | Printable text, up to 300 bytes. |
| `labels` | Like `X-Stratum-Labels`, up to 8. They are added to the request's usage record, after the application's own. |
| `headers` | Only `X-Stratum-*` and `Retry-After`, up to 8, printable, up to 200 bytes each. They go in the response to the client, on allow and on deny. |

Any other status from the service (not 200), a body that is not JSON, or a
`decision` other than `allow` or `deny` counts as not answering.

When the services answer:

- The first `deny`, in the order of `STRATUM_DECISION_URLS`, decides, even
  if another service did not answer.
- With no deny, labels and headers from every service are merged. If two
  services send the same header, the first one's value is kept.
- If a service did not answer, `STRATUM_DECISION_FAIL` decides.

The client gets a denial in the gateway's usual error format, with the
service's status, code and message. The denial is in the usage record with
the code as its reason.

With traces on ([Traces](traces.md)), the call carries a W3C `traceparent`
whose parent is the gateway's `stratum.decision` span, so a service that
traces joins the request's trace. `STRATUM_TRACE_PROPAGATION=false` leaves it
out.

## `POST /v1/report`

How each checked request ended, in batches of up to 500, about once a
second:

```json
{
  "v": 1,
  "reports": [
    { "request_id": "req_01J…", "time": "2026-11-02T14:03:11.204Z",
      "key_id": "agent:7b0c…", "team_id": "2000…0001", "user_id": "", "task": "ticket-4812",
      "provider": "openai", "model": "gpt-4o-mini", "content_sha256": "9f2c…",
      "status": 200, "reason": "ok", "tokens_in": 812, "tokens_out": 164,
      "duration_ms": 2310, "upstream_ms": 2290 }
  ]
}
```

- Any 2xx means the service took the batch.
- If no service takes a batch, it goes back to the queue, up to 10,000
  reports per gateway. Past that, new ones are dropped and counted.
- If at least one service took the batch, it is done. Reports tell the
  services what happened; the gateway does not wait for anything back.
- Requests the services denied are reported too, with their code as
  `reason`.

## Watching it

`/metrics` on the admin port:

| Metric | |
|---|---|
| `stratum_decision_allowed_total` | Requests the services let through. |
| `stratum_decision_denied_total` | Requests a service refused, or that failing closed refused. |
| `stratum_decision_skipped_total` | Requests that went without every answer (failing open). |
| `stratum_decision_errors_total` | Checks a service did not answer in time, or answered wrong. |
| `stratum_decision_reports_sent_total`, `…_dropped_total`, `…_buffered` | Reports taken, lost, and waiting. |

A rising `stratum_decision_skipped_total` means a service is too slow or
down. The gateway's log names it (`decision service did not answer`).

## Writing a service

- **Be fast.** The timeout covers the whole check, so answer from memory or
  from a store on the same network. Do the heavy work from the reports, not
  from the checks.
- **Expect every replica of the gateway.** Keep counters in a store all
  your replicas share, not in a gateway's memory.
- **Treat a missing report as normal.** A report can arrive late or be
  dropped. Rules that count, like budgets, may overshoot by the requests in
  flight.
- **Check the bearer token** when you set one, and listen only on the
  internal network.
