# ADR-0005: Fail static when the control plane is unreachable

- **Status:** Accepted
- **Date:** 2026-10-13

## Context

An earlier design stopped the gateway after 24 hours without a successful sync.
That turns a control plane outage into a data plane outage, which is exactly what
the split-plane architecture exists to prevent. During a control plane outage
nobody can issue new revocations either, so cutting traffic adds no security.

## Decision

The gateway keeps serving its last good snapshot for as long as the control
plane is unreachable. Staleness is visible (`stratum_snapshot_age_seconds`,
`/readyz` body) and should alert, but it never fails readiness or traffic.

A future, explicit per-organisation option may choose fail-closed after N hours
for environments that require it.

## Consequences

- Revocations issued just before an outage take effect when the control plane
  returns. Operators can still revoke at the edge by removing a gateway.
- Alerting on snapshot age is part of the reference deployment.
