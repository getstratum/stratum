# Release checklist

Tracks what is done and what still blocks the first public release.

## Phase 0 — foundations

- [x] New repository with its own history (ADR-0007)
- [x] One data plane, in Go, standard library only (ADR-0001)
- [x] Sync contract as JSON Schema with examples, validated in CI and decoded by gateway tests (ADR-0003)
- [x] CI: gofmt, vet, staticcheck, race tests, govulncheck, reproducible build check, contract validation, image builds
- [x] Release pipeline: multi-arch images, SBOM, cosign keyless signatures, SLSA provenance, signed binaries
- [x] Dependabot for Go, npm, Docker and GitHub Actions
- [ ] Pin every GitHub Action to a commit SHA (`pinact run`), then let Dependabot maintain the pins
- [ ] Pin base images by digest in both Dockerfiles
- [ ] Enable branch protection on `main` (required checks, signed-off commits, linear history)
- [ ] Enable GitHub private vulnerability reporting and OpenSSF Scorecard publishing
- [ ] Decide ADR-0006 (high availability in the open-source edition)

## Blocking the public release

- [ ] **Control plane on a supported Next.js.** It is on 14.2.35, the last 14.x
      release, which fixes the middleware authorization bypass (CVE-2025-29927)
      but not later advisories that are only fixed in 15.5.x and newer. The
      upgrade to Next 15/16 (React 19) is required before publishing.
- [ ] Control plane: replace the hard-coded `DEMO_ORG` with real multi-organisation scoping.
- [ ] Control plane: the Playground still calls `/me` and `/auth/login` on the
      gateway, which no longer exist. It should send a developer key directly.
- [ ] Control plane: migrations runner with locking and expand/contract discipline
      instead of running every SQL file in a loop.

## Phase 1 — static stability (started)

- [x] In-memory snapshot, atomic swap, encrypted persistence, guard against suspicious resyncs
- [x] Delta sync + periodic full resync, jitter, exponential backoff
- [x] `/livez` and `/readyz` independent of dependencies; graceful drain
- [x] Per-phase upstream timeouts and stream idle watchdog; load shedding
- [ ] Shared quota store (Valkey/Redis) with local fallback (ADR-0004)
- [ ] Circuit breaker per provider deployment and failover between equivalent deployments
- [ ] Retries before the first byte with a retry budget
- [ ] Signed snapshots in object storage as a second config channel (ADR-0003)
- [ ] Metrics push to the control plane for dashboards and billing
- [ ] OpenTelemetry traces and metrics with GenAI semantic conventions
