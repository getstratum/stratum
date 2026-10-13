# ADR-0001: One data plane, written in Go

- **Status:** Accepted
- **Date:** 2026-10-13

## Context

Two gateway implementations existed side by side: a TypeScript/Fastify gateway
(~950 lines, with the control plane sync client) and a Go gateway (~2,600 lines,
with PII scanning, SSE streaming and a storage interface). Two implementations of
the request hot path double the surface for bugs and split every fix in two.

## Decision

The Go gateway is the only data plane. The TypeScript gateway is retired after
its sync client was ported (done in `gateway/internal/syncer`). The gateway has
**no third-party Go dependencies**: standard library only.

User login and session handling, which the earlier Go gateway also carried,
belong to the control plane and were removed from the data plane.

## Consequences

- A single static binary and a distroless image of a few MB; no runtime, no
  `node_modules`, a very small supply-chain surface.
- Predictable latency and memory use under load.
- The JavaScript contributor pool is larger than the Go one. The control plane
  stays in JavaScript, so both communities still have a place to contribute.
- Shared types between control plane and gateway can no longer come from one
  TypeScript package; the sync contract is a JSON Schema instead (ADR-0003).
