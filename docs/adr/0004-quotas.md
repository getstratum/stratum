# ADR-0004: Quotas are enforced locally; a shared store is an optimisation

- **Status:** Accepted
- **Date:** 2026-10-13 (shared store implemented 2026-10-14)

## Context

Monthly token quotas need counters. With several gateway replicas, local
counters let a team spend up to N times its quota. A shared Valkey/Redis
gives fleet-wide counts, but a naive implementation (a round trip per
request) puts Valkey on the request path, and the data plane cannot be more
available than every dependency on that path.

## Decision

Quota counters live in Valkey when it is configured, but **requests never
wait for it**.

1. `Check` reads an in-memory value per team: the last fleet-wide total
   returned by Valkey plus the tokens this replica has consumed that Valkey
   has not confirmed yet.
2. A background loop (`STRATUM_QUOTA_SYNC_INTERVAL`, default 1 s, ±10%
   jitter) sends one batch per tick: the deltas accumulated since the last
   flush, plus reads for teams this replica served in the last 10 minutes.
   The batch is one `EVAL` of a short Lua script that applies the deltas
   with `INCRBY`, refreshes the TTL (40 days) and returns the totals.
3. The script is **idempotent per (replica, sequence number)**. Each process
   gets a random replica id; a batch that fails is retried unchanged, and a
   batch the server already applied (the reply was lost, not the write) is
   not applied again. Usage is counted exactly once.
4. Keys are `<prefix>:{quota}:tok:<YYYY-MM>:<team>`, in UTC months. The
   `{quota}` hash tag keeps every key of a batch on one slot, so the script
   also runs on a cluster. Usage recorded at the end of a month is flushed to
   that month's key even if the flush happens after midnight.
5. When Valkey is unreachable, replicas keep counting locally and keep the
   backlog. After `STRATUM_QUOTA_STALE_AFTER` (default 30 s) the store counts
   as down:
   - `STRATUM_QUOTA_FAIL_MODE=open` (default): keep enforcing against the
     last known totals plus local usage. Overspend during the outage is
     bounded by what the other replicas consume meanwhile.
   - `closed`: reject requests of teams that have a quota with
     `503 quota_unavailable`. This deliberately puts Valkey on the
     availability path for those teams; use it only when overspend is worse
     than downtime.
6. Without `STRATUM_VALKEY_URL` the gateway uses local counters, which are
   exact for a single replica.

A per-policy fail mode (the original proposal) is deferred: it needs a new
field in the sync contract and no adopter has asked for mixed modes yet.

## Consequences

- No latency is added to requests and a Valkey outage cannot fail a request
  in the default mode.
- Precision is "eventually exact": normal overspend is at most about one
  flush interval of traffic per replica, and is visible as
  `stratum_quota_pending_tokens`.
- Valkey must keep its data. A Valkey that restarts without persistence
  resets the month's counters (under-counting). The gateway cannot tell that
  apart from a deliberate reset, so the store wins and the event is counted
  in `stratum_quota_store_regressions_total` and logged. Run Valkey with AOF
  or a replica, or a managed service.
- A replica that is killed without a graceful shutdown loses at most one
  flush interval of usage. On graceful shutdown it flushes what is left
  (bounded to 3 s).
- Sentinel discovery is not implemented: point `STRATUM_VALKEY_URL` at a
  stable endpoint (a managed service, or a Kubernetes Service in front of the
  current primary).
- USD budgets are enforced from 0.3 without a price table in the gateway:
  the control plane sends each team's spend this month with every sync
  (`month_usage`), and the same report is a floor for the token count, so
  a Valkey that lost its data or a replica without Valkey no longer resets
  the month (docs/console/teams.md).
