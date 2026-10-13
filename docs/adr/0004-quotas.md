# ADR-0004: Quotas are enforced locally; a shared store is an optimisation

- **Status:** Accepted (shared store: Proposed)
- **Date:** 2026-10-13

## Context

Monthly token quotas need counters. A shared Redis gives exact global counts but
puts Redis in the request path.

## Decision

The gateway enforces quotas against in-process counters today. The next step is
a shared Valkey/Redis backend used **when it is reachable**, falling back to
local counters when it is not, with reconciliation on recovery. Each policy will
choose fail-open or fail-closed for quotas during an outage.

USD budgets are not enforced yet: the gateway needs a model price table from the
control plane first.

## Consequences

- With several replicas, or across restarts, enforcement is approximate. The
  maximum overspend is bounded by replicas × the window without a shared store.
- This is documented rather than hidden: quota precision is "eventually exact",
  not "transactionally exact".
