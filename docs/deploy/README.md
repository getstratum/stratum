# Deploying Stratum

| | Compose | Kubernetes |
|---|---|---|
| Demo | [deploy/demo](../../deploy/demo) | chart `stratum`, `values-demo.yaml` |
| Non-production | [deploy/nonprod](../../deploy/nonprod) | chart `stratum`, `values-nonprod.yaml` |
| Production | — | chart `stratum`, `values-prod.yaml` and a platform |

The chart and its profiles: [deploy/helm/stratum](../../deploy/helm/stratum).
Why this shape: [ADR-0022](../adr/0022-deployment-profiles.md).

Production, by platform:

| Platform | Guide | Tested |
|---|---|---|
| On-premise (kubeadm, RKE2, k3s) | [onprem.md](onprem.md) | kind in CI (the same chart, without a cloud) |
| OpenShift 4.14+ | [openshift.md](openshift.md) | rendered in CI |
| Amazon EKS | [eks.md](eks.md) | rendered in CI |
| Google GKE | [gke.md](gke.md) | rendered in CI; the topology, under failure, in [deploy/gcp](../../deploy/gcp) |
| Azure AKS | [aks.md](aks.md) | rendered in CI |

Whatever the platform, production means:

- **Gateways in three zones**, 3 at least (the chart refuses fewer than 2):
  a zone down costs a third of the capacity, not the service.
- **PostgreSQL with a standby in another zone** and point-in-time
  recovery. The gateways serve from their last configuration while it is
  away ([ADR-0005](../adr/0005-fail-static.md)); the console does not.
- **Valkey with a replica** for the shared quotas; never on the request
  path ([ADR-0004](../adr/0004-quotas.md)).
- **Secrets from a secret manager**, not values; a copy of
  `STRATUM_ENCRYPTION_KEY` outside the cluster.
- **NetworkPolicies enforced** (`helm test`), and the Pod Security
  `restricted` level on the namespace.
