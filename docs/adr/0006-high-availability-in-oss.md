# ADR-0006: High availability in the open-source edition

- **Status:** Proposed — pending maintainer decision
- **Date:** 2026-10-13

## Context

The reference target for the data plane is 99.99% availability. That is only
reachable with several gateway replicas across zones, behind a load balancer,
with zero-downtime deploys. The question is whether the open-source edition
ships the pieces for that (multi-replica support, Helm chart, HA guidance) or
whether they are reserved for a commercial edition.

## Options

**A. HA in OSS.** Multi-replica operation, the Helm chart and the HA reference
architecture are open source. Commercial editions differentiate on multi-region
active-active, a managed control plane with an SLA, SSO/RBAC, immutable audit
and compliance reporting. Comparable open-source gateways can already run as
multiple replicas in their free editions.

**B. HA in a commercial edition.** OSS documents and supports a single gateway
instance. The 99.99% target then applies to the commercial edition only, and the
OSS documentation must not claim it.

## Decision

Pending. Whatever is chosen, the gateway code itself stays stateless and
replica-safe; the decision is about packaging, documentation and support.

## Consequences

To be written once decided.
