# ADR-0007: A clean repository for the open-source release

- **Status:** Accepted
- **Date:** 2026-10-13

## Context

Development happened in a working copy that was a clone of an unrelated
open-source project, with Stratum living in subdirectories and that project's
full history attached.

## Decision

Stratum is published from a new monorepo with its own history:

```
gateway/        Go data plane
control-plane/  Next.js control plane and its SQL migrations
api/            sync contract (JSON Schema + examples)
deploy/         Docker Compose (and later Helm)
docs/           architecture and ADRs
```

Code reused from other projects keeps its original license notice in
`THIRD_PARTY_NOTICES.md`.

## Consequences

- Clear provenance for every file, which matters for adopters' legal review.
- History before this commit stays in the private working copies.
