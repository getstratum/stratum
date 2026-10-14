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
- [x] Decide ADR-0006: high availability is part of the open-source edition

## Blocking the public release

- [x] Control plane on a supported Next.js: Next 16.3 + React 19, Node 24 LTS.
      `npm audit --omit=dev` is clean and now gates CI.
- [ ] Control plane: replace the hard-coded `DEMO_ORG` with real multi-organisation scoping.
- [ ] Control plane: the Playground still calls `/me` and `/auth/login` on the
      gateway, which no longer exist. It should send a developer key directly.
- [x] Control plane: migrations runner (`control-plane/migrations/migrate.sh`) that
      applies each file once, tracked in `schema_migrations`, under an advisory lock.
- [ ] Control plane: expand/contract discipline for schema changes (documented in CONTRIBUTING).

## Phase 2 — HA topology (started)

- [x] Helm chart for the gateway: 3+ replicas, zone spread, PDB, HPA, zero-loss rollouts,
      graceful drain, hardened pod security; linted and schema-validated in CI, published as OCI
- [ ] Helm chart for the control plane (stateless replicas, external PostgreSQL); plain manifests in deploy/gcp/k8s for now
- [ ] GCP reference deployment (deploy/gcp): Terraform, Autopilot, global LB + Cloud Armor, Cloud SQL HA, Memorystore, failure tests. Statically validated; first real run pending
- [ ] Load test in CI: rolling deploy under constant load with zero errors, streams included
- [ ] SLO burn-rate alert rules (PrometheusRule) shipped with the chart

## Phase 1 — static stability (started)

- [x] In-memory snapshot, atomic swap, encrypted persistence, guard against suspicious resyncs
- [x] Delta sync + periodic full resync, jitter, exponential backoff
- [x] `/livez` and `/readyz` independent of dependencies; graceful drain
- [x] Per-phase upstream timeouts and stream idle watchdog; load shedding
- [x] Shared quota store in Valkey, off the request path, idempotent flushes, local fallback (ADR-0004)
- [ ] Circuit breaker per provider deployment and failover between equivalent deployments
- [ ] Retries before the first byte with a retry budget
- [ ] Signed snapshots in object storage as a second config channel (ADR-0003)
- [ ] Metrics push to the control plane for dashboards and billing
- [ ] OpenTelemetry traces and metrics with GenAI semantic conventions
