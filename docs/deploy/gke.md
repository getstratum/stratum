# Stratum on Google GKE

With `values-prod.yaml` and `platforms/gke.yaml`. [deploy/gcp](../../deploy/gcp)
is the full reference, built and tested under failure: Terraform for a
regional Autopilot cluster, Cloud SQL HA, Memorystore, the global load
balancer with Cloud Armor, k6 and failure tests. This guide is the same
choices with the umbrella chart.

| | Service | Notes |
|---|---|---|
| Cluster | GKE Autopilot or Standard, regional | three zones |
| Way in | GKE Gateway, class `gke-l7-global-external-managed` | `expose.type: gatewayApi`; a HealthCheckPolicy per Service |
| PostgreSQL | Cloud SQL for PostgreSQL 16, regional (HA), PITR | the Auth Proxy as a sidecar of the console (`control-plane.sidecars`), Workload Identity |
| Valkey | Memorystore for Valkey, with a replica, in-transit encryption | its CA in a ConfigMap (`caConfigMap`) |
| Secrets | Secret Manager through the External Secrets Operator | `externalSecrets` |
| Network policies | Dataplane V2 | `ingressFrom`: Google's load balancer ranges |

## Gateway and health checks

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata: { name: stratum, namespace: stratum }
spec:
  gatewayClassName: gke-l7-global-external-managed
  listeners:
    - { name: https, protocol: HTTPS, port: 443, tls: { mode: Terminate, options: { networking.gke.io/pre-shared-certs: stratum } } }
---
apiVersion: networking.gke.io/v1
kind: HealthCheckPolicy
metadata: { name: stratum-gateway, namespace: stratum }
spec:
  default: { config: { type: HTTP, httpHealthCheck: { port: 20128, requestPath: /readyz } } }
  targetRef: { group: "", kind: Service, name: stratum-gateway }
---
apiVersion: networking.gke.io/v1
kind: HealthCheckPolicy
metadata: { name: stratum-control-plane, namespace: stratum }
spec:
  default: { config: { type: HTTP, httpHealthCheck: { port: 3000, requestPath: /api/healthz } } }
  targetRef: { group: "", kind: Service, name: stratum-control-plane }
```

And a GCPBackendPolicy with `timeoutSec: 900` on `stratum-gateway` for
long streams.

## Install

```sh
helm install stratum oci://ghcr.io/getstratum/charts/stratum -n stratum \
  -f values-prod.yaml -f platforms/gke.yaml \
  --set global.domain=stratum.example.com \
  --set 'control-plane.sidecars[0].args[3]=my-project:us-central1:stratum' \
  --set control-plane.serviceAccount.annotations.iam\.gke\.io/gcp-service-account=stratum-cp@my-project.iam.gserviceaccount.com \
  --set gateway.quota.valkey.url=rediss://10.0.0.5:6379/0
```

`DATABASE_URL` through the proxy: `postgresql://stratum:<password>@127.0.0.1:5432/stratum?sslmode=disable`.
