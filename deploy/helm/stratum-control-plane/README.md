# Helm chart: stratum-control-plane

The Stratum control plane: the console, and the configuration source the
gateways sync from. It is not on the request path: gateways keep serving with
their last configuration while it is down
([ADR-0005](../../../docs/adr/0005-fail-static.md)). Its pods are stateless;
everything lives in PostgreSQL, which you provide (a managed service, or an
operator such as CloudNativePG, with backups and a standby).

What the defaults give you:

| Concern | Default |
|---|---|
| Replicas | 2 (the chart refuses fewer); optional HPA |
| Placement | spread across zones (`DoNotSchedule`) and nodes (`ScheduleAnyway`) |
| Voluntary disruptions | PodDisruptionBudget, at least 1 replica up |
| Rollouts | `maxUnavailable: 0`, `maxSurge: 1` |
| Database migrations | applied by each pod before it starts (init container), once per file, under a lock |
| Shutdown | `preStop` sleep so the load balancer stops routing first |
| Probes | `/api/healthz`, which does not depend on the database |
| Security | non-root, read-only root filesystem, no capabilities, seccomp `RuntimeDefault`, no service account token |

## Install

1. A PostgreSQL 16 database and a user that owns it.
2. The secret (or sync it from your secret manager):

   ```sh
   kubectl create namespace stratum
   kubectl -n stratum create secret generic stratum-control-plane \
     --from-literal=DATABASE_URL='postgresql://stratum:...@db.example.internal:5432/stratum?sslmode=verify-full' \
     --from-literal=STRATUM_ENCRYPTION_KEY="$(openssl rand -hex 32)"
   ```

   Keep a copy of `STRATUM_ENCRYPTION_KEY` outside the cluster: provider
   credentials and second factors are encrypted with it. `DATABASE_URL` is
   read by the console (node-postgres) and by the migrations (psql), so use
   `sslmode` values both understand: `disable`, `require`, `verify-ca`,
   `verify-full`.

3. Install:

   ```sh
   helm install stratum-control-plane oci://ghcr.io/getstratum/charts/stratum-control-plane \
     -n stratum --set existingSecret=stratum-control-plane
   ```

4. Create your organization and its first Owner (prints a password once; the
   first sign-in sets up the second factor):

   ```sh
   kubectl -n stratum exec deploy/stratum-control-plane -c control-plane -- \
     node scripts/stratum-admin.mjs create-owner --email you@example.com --org-name "Your company"
   ```

5. Expose it over https (`ingress.enabled`, or your own load balancer in
   front of the service), register a gateway in the console and install the
   [stratum-gateway](../README.md) chart with `controlPlane.url` set to that
   address. Gateways refuse a plain http control plane.

## Migrations

Each pod runs `stratum-migrations` (the same image tag as the console)
before the console starts. Every SQL file is applied once and recorded in
`schema_migrations`; an advisory lock makes pods that start together wait
for each other, and a pod with nothing to apply goes straight on. In a
rolling update the first new pod applies the new release's migrations while
the old pods keep serving, so migrations stay compatible with the previous
release.

To run them yourself instead (a separate pipeline step, or a database user
that the console does not get), set `migrations.enabled=false` and run the
image once per upgrade:

```sh
kubectl -n stratum run stratum-migrate --rm -it --restart=Never \
  --image=ghcr.io/getstratum/stratum-migrations:<version> \
  --env="DATABASE_URL=postgresql://..."
```

## Behind a proxy or a cloud load balancer

`console.trustedProxyHops` is how many proxies append to `X-Forwarded-For`
in front of the console, so the audit log records the client's address: 1
behind an ingress controller (the default), 2 behind Google Cloud's load
balancer.

## Cloud SQL and other sidecars

`sidecars` adds native sidecars (Kubernetes 1.29+) that start before the
migrations and the console, and stop after them. For Cloud SQL through the
Auth Proxy with Workload Identity:

```yaml
existingSecret: stratum-control-plane   # DATABASE_URL points at 127.0.0.1:5432, sslmode=disable
console:
  trustedProxyHops: 2
serviceAccount:
  annotations:
    iam.gke.io/gcp-service-account: stratum-cp@PROJECT.iam.gserviceaccount.com
sidecars:
  - name: cloud-sql-proxy
    image: gcr.io/cloud-sql-connectors/cloud-sql-proxy:2.14.1
    restartPolicy: Always
    args: [--private-ip, --port=5432, --health-check, --http-address=0.0.0.0,
           --http-port=9801, --exit-zero-on-sigterm, PROJECT:REGION:INSTANCE]
    startupProbe:
      httpGet: { path: /startup, port: 9801 }
      periodSeconds: 1
      failureThreshold: 60
    securityContext:
      runAsNonRoot: true
      runAsUser: 65532
      allowPrivilegeEscalation: false
      readOnlyRootFilesystem: true
      capabilities: { drop: ["ALL"] }
```

deploy/gcp still deploys the control plane from plain manifests
(`deploy/gcp/k8s/control-plane.yaml`), with two services for two Cloud Armor
policies.

## Without internet access

The model catalog feed (ADR-0012) is fetched once a day. Turn it off with
`console.modelCatalogUrl=off` and apply the repository's
`catalog/models.json` by hand:

```sh
kubectl -n stratum cp catalog/models.json stratum/<pod>:/tmp/models.json -c control-plane
kubectl -n stratum exec <pod> -c control-plane -- \
  node scripts/stratum-admin.mjs catalog-update --file /tmp/models.json
```

## Single-zone and development clusters

```sh
--set topologySpread.zoneWhenUnsatisfiable=ScheduleAnyway
```
