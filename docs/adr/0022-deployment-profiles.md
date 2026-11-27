# ADR-0022: One chart, three profiles: demo, non-production, production

- **Status:** Accepted
- **Date:** 2026-11-27

## Context

Stratum could be deployed four ways, each complete in itself: the demo
(Compose, fixed secrets, a mock LLM), the development stack (Compose), the
gateway's and the console's charts (production, highly available), and the
GCP reference (Terraform and scripts). Between a demo and production there
was nothing: a team that wanted Stratum for tests, policy validation or
training put production's charts together by hand, with their database,
Secrets, registration of the gateway and a way in. And a demo on
Kubernetes did not exist.

Stratum Enterprise's chart already gathered the open source charts with
PostgreSQL (bundled, CloudNativePG or external), Valkey, NetworkPolicies
and ExternalSecrets, which an open source installation needs as much.

## Decision

- **An umbrella chart, `stratum`**, with the gateway's and the console's
  charts as they are, PostgreSQL (`bundled`, `cnpg`, `external`), Valkey,
  a way in (`ingress`, `route`, `gatewayApi`), NetworkPolicies,
  ExternalSecrets, a daily backup and, for the demo, the mock LLM and the
  demo organization. Stratum Enterprise's chart builds on it.
- **Three profiles**, files next to it: `values-demo.yaml`,
  `values-nonprod.yaml`, `values-prod.yaml`; and **platform files**
  (`platforms/`) for on-premise, OpenShift, EKS, GKE and AKS, which go on
  top of a profile.
- **Secrets by mode**: `existing` (production: the chart only reads them),
  `generate` (made once with random values and kept across upgrades and
  after an uninstall, `helm.sh/resource-policy: keep`), `demo` (fixed and
  public).
- **A first run without the console**: `stratum-admin bootstrap` makes
  the organization, its first Owner while it has none, and registers the
  gateway with the instance id and sync token the installation chose. It
  changes nothing when all is there, so the chart runs it after every
  install and upgrade, and Compose on every `up`.
- **One replica allowed only by saying so**: the gateway's and the
  console's charts still refuse fewer than two unless
  `allowSingleReplica`, which only the demo and non-production profiles
  set.
- **OpenShift** (`global.openshift`): no pod asks for a fixed user, group
  or fsGroup, so restricted-v2 assigns them; the bundled PostgreSQL is
  refused there.
- **Compose for demo and non-production**, never production:
  `deploy/demo` and `deploy/nonprod` (released images, its own secrets,
  two gateways behind Caddy with HTTPS, Valkey, a daily dump).
- **Tested on kind in CI**: the demo profile (the demo organization loads,
  traffic goes through the gateway) and the non-production one (bootstrap,
  the gateway serves, backup, an upgrade keeps the secrets, NetworkPolicies
  enforced); every profile and platform rendered against the Kubernetes
  schemas.

## Consequences

- One place to say how Stratum is installed, from a laptop to three zones.
- The demo's files (`setup.mjs`, `traffic.mjs`, the seed) live in the
  chart (`files/demo`), and Compose mounts them from there: one copy.
- The release is named `stratum`, one per namespace: the gateways find the
  console by that name. The chart refuses another while that holds.
- The platform files are tested by rendering only; GKE's choices are the
  ones `deploy/gcp` tests under failure. OpenShift, EKS and AKS are
  documented and rendered, not yet installed on the real thing.
- `generate` keeps secrets in the cluster: fine for tests, not for
  production, where the secret manager is the source.
