# ADR-0003: Configuration distribution and the sync contract

- **Status:** Accepted (decision 5 superseded by ADR-0008)
- **Date:** 2026-10-13

## Context

Gateways pull configuration from the control plane with
`GET /api/internal/sync?since_version=N`. Versions come from a PostgreSQL
sequence, and sequence values can commit out of order: a transaction holding
version 41 can commit after one holding 42. A gateway that already asked for
`since_version=42` would then never see 41.

## Decision

1. **Contract as a schema.** The sync response is defined once in
   `api/sync/v2/sync-response.schema.json`. CI validates the examples against
   the schema and the gateway decodes the same examples in its tests.
   Compatibility: control plane N serves gateway N-1, and gateway N understands
   control plane N-1.
2. **Deltas plus periodic full resync.** Deltas keep steady-state traffic small;
   a full resync every `STRATUM_FULL_RESYNC_INTERVAL` (default 10 min) makes
   gateways converge even when a delta skipped a row. A version that goes
   backwards also triggers a full resync.
3. **Jitter and backoff.** Sync intervals carry ±20% jitter and failures back
   off exponentially (1 s to 2 min) so a fleet never hammers a recovering
   control plane in lockstep.
4. **Standalone mode.** The same format, as a file (`STRATUM_CONFIG_FILE`), lets
   the gateway run without any control plane (GitOps).
5. **Superseded by ADR-0008:** a brand-new gateway bootstraps during a control
   plane outage from an encrypted copy of the snapshot that the gateways keep
   in Valkey, inside the data plane's failure domain, instead of from object
   storage.

## Consequences

- Up to one full-resync interval of delay in the rare out-of-order case.
- The control plane must keep the schema and its examples current; CI fails
  otherwise.
