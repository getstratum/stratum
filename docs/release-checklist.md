# Release checklist

Tracks what is done and what still blocks the first public release.

## Phase 0 — foundations

- [x] New repository with its own history (ADR-0007)
- [x] One data plane, in Go, standard library only (ADR-0001)
- [x] Sync contract as JSON Schema with examples, validated in CI and decoded by gateway tests (ADR-0003)
- [x] CI: gofmt, vet, staticcheck, race tests, govulncheck, reproducible build check, contract validation, image builds
- [x] Release pipeline: multi-arch images, SBOM, cosign keyless signatures, SLSA provenance, signed binaries
- [x] Dependabot for Go, npm, Docker and GitHub Actions
- [x] Pin every GitHub Action to a commit SHA, maintained by Dependabot with a 14-day cooldown
- [x] Pin base images by tag and digest (`scripts/pin-images.sh`, checked in CI), maintained by Dependabot
- [ ] Enable branch protection on `main` (required checks, signed-off commits, linear history)
- [ ] Enable GitHub private vulnerability reporting and OpenSSF Scorecard publishing
- [x] Decide ADR-0006: high availability is part of the open-source edition

## Blocking the public release

- [x] Control plane on a supported Next.js: Next 16.3 + React 19, Node 24 LTS.
      `npm audit --omit=dev` is clean and now gates CI.
- [x] Control plane: real multi-organisation scoping instead of the hard-coded `DEMO_ORG`;
      five roles checked on the server for every console API route; server-side
      sessions; password sign-in; audit log (docs/console/access-control.md).
- [x] Control plane: the Playground, which called gateway routes that no longer
      exist, is removed until it uses the current gateway contract.
- [x] Control plane: a new installation starts empty. The demo organization moved out of the
      migrations to `control-plane/seed/demo.sql`, loaded only by the functional test and the GCP
      kit; the first account and its organization come from `stratum-admin create-owner --org-name`.
- [x] Control plane: TOTP second factor, required for Owner and Admin, with recovery codes and resets
      (docs/console/access-control.md).
- [x] Control plane: the console's Providers page edits `provider_configs` (what gateways read), with
      presets, custom OpenAI-compatible endpoints and a connection test; gateways are registered,
      rotated and disabled from the console.
- [x] Control plane: agent keys (`agents` table) reach gateways through the sync (migration 017).
- [x] Gateway: an agent's fixed model, set in the console, travels in the sync and applies to every
      request of its key (still within the team's policy).
- [x] Control plane: `request_logs` partitions are created ahead of time: 24 months by migration 019, kept
      ahead by the control plane once a day, and a default partition so an insert never fails.
- [x] Control plane: functional test of the console in a browser (`control-plane/e2e`), run in CI
      against a console, a gateway and a mock provider, and on GCP with `make test-console`.
- [x] Control plane: migrations runner (`control-plane/migrations/migrate.sh`) that
      applies each file once, tracked in `schema_migrations`, under an advisory lock.
- [ ] Control plane: expand/contract discipline for schema changes (documented in CONTRIBUTING).

## Phase 2 — HA topology (started)

- [x] Helm chart for the gateway: 3+ replicas, zone spread, PDB, HPA, zero-loss rollouts,
      graceful drain, hardened pod security; linted and schema-validated in CI, published as OCI
- [x] Helm chart for the control plane (deploy/helm/stratum-control-plane): 2+ stateless replicas, external PostgreSQL,
      migrations from the `stratum-migrations` image in an init container, zone spread, PDB, optional
      Ingress and HPA, native sidecars (Cloud SQL Auth Proxy). deploy/gcp still uses plain manifests.
- [x] GCP reference deployment (deploy/gcp): Terraform, Autopilot, global LB + Cloud Armor, Cloud SQL HA, Memorystore with TLS and token auth, failure tests. Three real runs; the last one, 0 Stratum errors in 52,805 requests (docs/testing/gcp-2026-10-18.md)
- [ ] Load test in CI: rolling deploy under constant load with zero errors, streams included
- [ ] SLO burn-rate alert rules (PrometheusRule) shipped with the chart

## Phase 1 — static stability (started)

- [x] In-memory snapshot, atomic swap, encrypted persistence, guard against suspicious resyncs
- [x] Delta sync + periodic full resync, jitter, exponential backoff
- [x] `/livez` and `/readyz` independent of dependencies; graceful drain
- [x] Per-phase upstream timeouts and stream idle watchdog; load shedding
- [x] Shared quota store in Valkey, off the request path, idempotent flushes, local fallback (ADR-0004)
- [x] Circuit breaker per provider configuration (ADR-0010)
- [ ] Failover between equivalent deployments (needs the console to say which are equivalent; with model routing)
- [x] Retries before the first byte with a retry budget (ADR-0010)
- [x] A gateway can start during a control plane outage from the encrypted snapshot copy in Valkey (ADR-0008)
- [x] Usage reported to the control plane, one record per request, for the console's usage, spend and logs (ADR-0009)
- [ ] Usage on durable storage next to the gateway, so a crashed process loses none (needed for billing)
- [ ] OpenTelemetry traces and metrics with GenAI semantic conventions
