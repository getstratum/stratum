# Stratum on OpenShift

OpenShift 4.14 or later (or OKD), with `values-prod.yaml` and
`platforms/openshift.yaml`.

## What changes on OpenShift

- **Security context constraints.** Every Stratum pod runs under
  `restricted-v2`: `global.openshift: true` keeps the chart from asking for
  a user, group or fsGroup, and OpenShift assigns the namespace's. Nothing
  needs `anyuid`.
- **Routes** instead of Ingress (`expose.type: route`): edge TLS with the
  router's certificate, or your own on each Route; 15-minute timeout for
  long streamed answers.
- **PostgreSQL** from CloudNativePG, installed from OperatorHub (certified
  operator), or a database outside the cluster. The bundled PostgreSQL is
  refused here.
- **NetworkPolicies** with OVN-Kubernetes: the router's pods are
  `policy-group.network.openshift.io/ingress`, and user workload
  monitoring scrapes the gateways' metrics.
- **Valkey**: a managed Redis, or Valkey's chart with a security context
  restricted-v2 admits (off by default in `openshift.yaml`).

## Install

```sh
oc new-project stratum
# OperatorHub → CloudNativePG → Install (all namespaces or this one)
oc -n stratum create secret generic stratum-postgresql --type=kubernetes.io/basic-auth \
  --from-literal=username=stratum --from-literal=password="$(openssl rand -hex 24)"
# stratum-control-plane and stratum-gateway: deploy/helm/stratum/README.md (Production);
# DATABASE_URL: postgresql://stratum:<password>@stratum-cnpg-rw:5432/stratum

helm install stratum oci://ghcr.io/getstratum/charts/stratum -n stratum \
  -f values-prod.yaml -f platforms/openshift.yaml \
  --set global.domain=apps.cluster.example.com
oc -n stratum get routes
helm test stratum -n stratum
```

For non-production on OpenShift: `values-nonprod.yaml` with
`postgresql.mode: cnpg`, `cnpg.enabled: true`, `cnpg.cluster.instances: 1`.

Not yet installed on a real OpenShift cluster by the project: rendered in
CI. Tell us how it went.
