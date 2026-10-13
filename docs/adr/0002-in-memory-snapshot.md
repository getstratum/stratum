# ADR-0002: Gateway state is an immutable in-memory snapshot

- **Status:** Accepted
- **Date:** 2026-10-13

## Context

The earlier gateways read Redis (TypeScript) or a database (Go) on every request
to authenticate and load the policy. That put a stateful dependency in the
request path: if Redis or the database was slow or down, every request failed.

## Decision

API keys, team policies and provider credentials live in an immutable
`Snapshot`, indexed for O(1) lookups and published through an atomic pointer.
The config source builds a new snapshot and swaps it in; requests never block
and never touch the network except to call the LLM provider.

The snapshot is persisted to disk, encrypted with AES-256-GCM
(`STRATUM_SNAPSHOT_KEY`), written atomically (temp file, fsync, rename). A
gateway can therefore start and serve while the control plane is unreachable.

Full resyncs pass a guard before replacing the snapshot: if more than
`STRATUM_SNAPSHOT_MAX_DROP_RATIO` of active keys would **vanish without an
explicit revocation**, or every provider would disappear, the resync is
rejected and the previous snapshot stays in place. Explicit revocations always
pass, so a mass revocation during an incident is never blocked.

## Consequences

- Authentication costs one SHA-256 and one map lookup.
- Memory grows with the number of keys; thousands of keys are a few MB.
- Configuration changes reach the gateway at sync speed (seconds), not instantly.
- A control plane bug or a database restored from an old backup cannot wipe
  out access for everyone in one sync.
