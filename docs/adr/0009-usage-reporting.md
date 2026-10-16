# ADR-0009: Gateways report each request's usage to the control plane

- **Status:** Accepted
- **Date:** 2026-10-16

## Context

The console's usage, spend and request log views read `request_logs`, but
since the gateway was rewritten (ADR-0001) nothing writes to it in control
plane mode: the gateway counts tokens for quotas (ADR-0004) and logs each
request to stdout, and that is all. Budgeting, the savings view and, later,
an operator view of consumption per organization all need the same data.

An older endpoint, `POST /api/internal/metrics`, accepted aggregates per
time window from a data plane that no longer exists. Nothing called it.

## Decision

1. **One record per request with a valid key**, refused requests included
   (the console shows denials too). Requests without a valid key belong to
   no organization: they are logged and counted, not reported. A record
   holds metadata only: key, team, provider, model, status, reason,
   durations, tokens and the kinds of sensitive data the policy found.
   Never prompts, completions or credentials. Contract:
   `api/usage/v1/usage-batch.schema.json`.

2. **Off the request path.** The proxy appends the record to an in-memory
   buffer and returns. A background loop sends batches of up to 500 to
   `POST /api/internal/usage` every `STRATUM_USAGE_INTERVAL` (10 s), or as
   soon as a full batch is waiting, authenticated with the gateway's sync
   token. Nothing the control plane does can slow down or fail a request.

3. **At least once, stored once.** The gateway gives every record a random
   UUID. The control plane stores it as `request_logs.id`, whose primary key
   `(id, created_at)` makes a batch sent again (its answer was lost) a no-op.
   The gateway removes a batch from its buffer only when the control plane
   answers 2xx.

4. **Outages.** If the control plane is down or refuses the token, records
   stay buffered and the gateway retries with backoff up to 2 minutes. The
   buffer is bounded (`STRATUM_USAGE_BUFFER`, 100,000 records, roughly
   40 MB): past it, new records are dropped and counted in
   `stratum_usage_records_dropped_total`. A batch the control plane calls
   malformed (400, 413) is dropped too, so one bad batch cannot block the
   rest. On a graceful shutdown the gateway sends what is buffered after
   the last request finishes.

5. **The control plane decides ownership and cost.** The organization is
   the reporting gateway's. A team, person or agent ID that is not in that
   organization is stored as NULL, so a gateway cannot charge another
   organization. The cost is computed at ingest from the model catalog
   (`ai_models`), not sent by gateways. Records it cannot store (malformed,
   older than 35 days, more than 5 minutes in the future) are skipped and
   counted in the answer; the rest of the batch is stored.

6. The legacy `POST /api/internal/metrics` is removed. Its table,
   `stratum_metrics`, is left in place and unused.

## Consequences

- The console's existing views show real traffic in control plane mode,
  which is what Budgeting and the savings view build on.
- Usage is not exact under failure: records buffered when a gateway process
  dies without a graceful shutdown (OOM kill, node loss) are lost, up to
  `STRATUM_USAGE_INTERVAL` of traffic, or more during a control plane
  outage. That is acceptable for dashboards and estimates. Billing that
  must not lose a request needs the buffer on durable storage next to the
  gateway (Valkey, as ADR-0008 does for the snapshot); that is future work.
- Quotas stay on their own path (ADR-0004): they are enforced from the
  shared counters, not from what reaches the control plane.
- At 40 requests per second a gateway sends one batch of about 400 records
  every 10 s. The control plane stores a batch in one statement.
- The hybrid deployment needs nothing new: the gateway already reaches the
  control plane for the sync, and the usage endpoint sits next to it (the
  GCP kit routes both to the same backend, behind the same allowlist).
