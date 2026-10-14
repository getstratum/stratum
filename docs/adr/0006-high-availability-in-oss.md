# ADR-0006: High availability in the open-source edition

- **Status:** Accepted
- **Date:** 2026-10-13

## Context

The reference target for the data plane is 99.99% availability. That is only
reachable with several gateway replicas across zones, behind a load balancer,
with zero-downtime deploys. The question was whether the open-source edition
ships the pieces for that (multi-replica support, Helm chart, HA guidance) or
whether they are reserved for a commercial edition.

Two options were considered:

**A. HA in OSS.** Multi-replica operation, the Helm chart and the HA reference
architecture are open source.

**B. HA in a commercial edition.** OSS documents a single gateway instance and
the 99.99% target applies only to the commercial edition.

## Decision

Option A. Everything needed to run the gateway and the control plane in a
highly available, single-region topology is open source: stateless replicas,
the Helm chart, shared quota counters, probes and graceful drain, the HA
reference architecture and its failure-mode tests.

Commercial editions differentiate on what an organisation buys rather than on
basic reliability:

- multi-region active-active data planes with global traffic management
- a managed control plane operated with a contractual SLA
- SSO (SAML/OIDC) and fine-grained RBAC
- immutable, exportable audit logs and compliance evidence (EU AI Act, ISO 42001)
- support with response-time SLAs

## Consequences

- A promise of 99.99% for the data plane is credible in the open-source
  edition, and adopters can verify it themselves.
- Comparable open-source gateways already run as multiple replicas in their
  free editions; Stratum is not at a disadvantage on that axis.
- Every HA feature must work without commercial components. Features that
  only make sense across regions belong to the commercial edition.
