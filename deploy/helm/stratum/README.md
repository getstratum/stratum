# Helm chart: stratum

Stratum in one release: the console (control plane), the gateways and what
they need. One chart for three uses, by profile:

| | `values-demo.yaml` | `values-nonprod.yaml` | `values-prod.yaml` |
|---|---|---|---|
| For | looking around in minutes | functional tests, policy validation, training | production |
| Gateways | 1 | 2 | 3 to 12 (HPA), across zones |
| Console | 1 | 1 | 2 |
| PostgreSQL | in the cluster, one instance | in the cluster, one instance, a dump every day | yours (managed) or CloudNativePG, 3 instances, backups to object storage |
| Valkey | no | yes | yours (managed) or its chart |
| Data at install | the demo organization (Acme), a mock LLM | the organization, its Owner and the gateway (bootstrap) | none: bootstrap once, or by hand |
| Secrets | fixed and public (`demo`) | made once by the chart, kept (`generate`) | yours (`existing`, or the External Secrets Operator) |
| Way in | port-forward | Ingress with TLS | Ingress, Gateway API or Route, with TLS |
| NetworkPolicies | no | yes | yes |
| About | 2 CPU, 2 GiB | 3 CPU, 4 GiB | from 6 CPU, 6 GiB, plus the database |

The same with Docker Compose: [deploy/demo](../../demo) and
[deploy/nonprod](../../nonprod). Production is Kubernetes only.

Where you run it, on top of a profile: `platforms/onprem.yaml`,
`platforms/openshift.yaml`, `platforms/eks.yaml`, `platforms/gke.yaml`,
`platforms/aks.yaml`, with their guides in [docs/deploy](../../../docs/deploy).

## Demo

```sh
helm install stratum oci://ghcr.io/getstratum/charts/stratum -n stratum-demo --create-namespace \
  -f values-demo.yaml
kubectl -n stratum-demo port-forward svc/stratum-control-plane 3000:80
```

<http://localhost:3000>: `auditor@acme.com` / `stratum-demo-auditor`. Its
secrets are public: **never real data or real provider keys**.

## Non-production

```sh
helm install stratum oci://ghcr.io/getstratum/charts/stratum -n stratum-test --create-namespace \
  -f values-nonprod.yaml \
  --set global.domain=test.stratum.example.com \
  --set bootstrap.orgName="Acme (pruebas)" --set bootstrap.ownerEmail=ana@acme.com \
  --set expose.className=nginx --set expose.tls.clusterIssuer=letsencrypt
kubectl -n stratum-test logs job/stratum-bootstrap-1     # the Owner's password, once
```

The chart makes the Secrets the first time and keeps them across upgrades
and after an uninstall. **Copy `stratum-control-plane` somewhere safe**: its
`STRATUM_ENCRYPTION_KEY` reads the providers' keys and the second factors.

## Production

1. PostgreSQL 16 with high availability: a managed service, or
   `postgresql.mode: cnpg` (the CloudNativePG operator in the cluster) with
   `cnpg.backups`.
2. Valkey or Redis with a replica behind one endpoint, for
   `gateway.quota.valkey.url`.
3. The Secrets, by `kubectl` or `externalSecrets`:
   `stratum-control-plane` (`DATABASE_URL`, `STRATUM_ENCRYPTION_KEY`) and
   `stratum-gateway` (`STRATUM_INSTANCE_ID`, `STRATUM_SYNC_TOKEN`,
   `STRATUM_SNAPSHOT_KEY`, `STRATUM_VALKEY_PASSWORD`). The instance id and
   sync token are yours to choose (`dp_` and 32 hex characters;
   `dp_sync_` and 64): the bootstrap registers them.
4. Install, with the bootstrap on the first time:

   ```sh
   helm install stratum oci://ghcr.io/getstratum/charts/stratum -n stratum \
     -f values-prod.yaml -f platforms/eks.yaml \
     --set global.domain=stratum.example.com \
     --set bootstrap.enabled=true --set bootstrap.orgName=Acme --set bootstrap.ownerEmail=ana@acme.com
   kubectl -n stratum logs job/stratum-bootstrap-1
   helm upgrade stratum ... --reuse-values --set bootstrap.enabled=false
   ```

5. `helm test stratum -n stratum` checks the NetworkPolicies are enforced.

What it guarantees, and why: [docs/architecture/overview.md](../../../docs/architecture/overview.md),
[ADR-0006](../../../docs/adr/0006-high-availability-in-oss.md) and
[ADR-0022](../../../docs/adr/0022-deployment-profiles.md).

## Values

Every value of the gateway's and the console's charts works under
`gateway` and `control-plane`; [values.yaml](values.yaml) explains the
rest: `global` (domain, hosts, OpenShift), `secrets`, `bootstrap`,
`postgresql`, `cnpg`, `backup`, `valkey`, `expose`, `demo`,
`networkPolicy`, `externalSecrets`, `resourceQuota`.

The release is named `stratum` (the gateways find the console at
`http://stratum-control-plane`); one release per namespace.

## The way in

`expose.type`: `ingress` (with `className`), `route` (OpenShift, edge TLS),
`gatewayApi` (HTTPRoutes on your Gateway, `parentRefs`) or `none`. Two
hosts: `consola.<domain>` (the console, the gateways' sync, the
applications' sign-in) and `gateway.<domain>` (the API: `/v1`, `/proxy`,
`/mcp`). Each allows 15 minutes for long streamed answers where the
platform lets the chart say so; `hostAnnotations` adds what a load
balancer needs per host (health check paths: `/api/healthz`, `/readyz`).
