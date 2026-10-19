# Helm chart: stratum-gateway

Highly available reference deployment of the Stratum gateway (data plane),
following [docs/architecture/overview.md](../../docs/architecture/overview.md).
The control plane has its own chart:
[stratum-control-plane](stratum-control-plane/README.md).

What the defaults give you:

| Concern | Default |
|---|---|
| Replicas | 3 minimum (HPA 3–12 on CPU); the chart refuses fewer than 2 |
| Placement | spread across zones (`DoNotSchedule`) and nodes (`ScheduleAnyway`) |
| Voluntary disruptions | PodDisruptionBudget, at most 1 replica down |
| Rollouts | `maxUnavailable: 0`, `maxSurge: 1`: capacity never drops |
| Shutdown | readiness fails first, then in-flight streams get up to 10 min; the termination grace period is derived from both |
| Probes | `/readyz` and `/livez` on the gateway port; neither depends on the control plane |
| Security | non-root, read-only root filesystem, no capabilities, seccomp `RuntimeDefault`, no service account token |
| Metrics | separate ClusterIP service on port 9090; optional ServiceMonitor |
| Quotas | shared across replicas through Valkey when `quota.valkey.url` is set; off the request path |

## Install (control plane mode)

1. Register the gateway in the control plane and keep the sync token and
   instance id it returns.
2. Create the secret (or sync it from your secret manager):

   ```sh
   kubectl create namespace stratum
   kubectl -n stratum create secret generic stratum-gateway \
     --from-literal=STRATUM_SYNC_TOKEN=dp_sync_... \
     --from-literal=STRATUM_INSTANCE_ID=dp_... \
     --from-literal=STRATUM_SNAPSHOT_KEY="$(openssl rand -hex 32)"
   ```

3. Install:

   ```sh
   helm install stratum oci://ghcr.io/getstratum/charts/stratum-gateway \
     -n stratum \
     --set controlPlane.url=https://stratum-cp.example.com \
     --set existingSecret=stratum-gateway
   ```

## Install (standalone mode)

```sh
kubectl -n stratum create secret generic provider-keys \
  --from-literal=OPENAI_API_KEY=sk-... --from-literal=ANTHROPIC_API_KEY=sk-ant-...

helm install stratum oci://ghcr.io/getstratum/charts/stratum-gateway -n stratum \
  --set mode=static \
  --set-file static.config=stratum.json \
  --set 'extraEnvFrom[0].secretRef.name=provider-keys'
```

## Shared quotas (Valkey)

With more than one replica, point the gateway at a Valkey (or Redis 6.2+) so
monthly token quotas are counted fleet-wide. Without it, each replica counts
on its own and a team can spend up to N times its quota.

```sh
kubectl -n stratum create secret generic stratum-gateway ... \
  --from-literal=STRATUM_VALKEY_PASSWORD=...

helm upgrade stratum oci://ghcr.io/getstratum/charts/stratum-gateway -n stratum \
  --reuse-values --set quota.valkey.url=redis://valkey.stratum.svc:6379/0
```

Valkey is never on the request path: a Valkey outage does not fail requests
(with the default `quota.failMode=open`), and usage counted meanwhile is
written once it returns. Bring your own Valkey: a managed service, or any
Valkey chart with **persistence (AOF) or a replica** enabled, behind a stable
endpoint (Sentinel discovery is not implemented). A Valkey that restarts empty
resets the month's counters. Alert on `stratum_quota_store_age_seconds` and
`stratum_quota_store_regressions_total`.

Outside a single trusted network, encrypt and authenticate the link: a
`rediss://` URL, the password (or token) in `STRATUM_VALKEY_PASSWORD`, and,
when the server's certificate comes from a private CA (Memorystore with
in-transit encryption, a self-managed CA), that CA in a ConfigMap:

```sh
kubectl -n stratum create configmap valkey-ca --from-file=ca.crt=server-ca.pem
helm upgrade stratum oci://ghcr.io/getstratum/charts/stratum-gateway -n stratum --reuse-values \
  --set quota.valkey.url=rediss://10.0.0.5:6379/0 --set quota.valkey.caConfigMap=valkey-ca
```

The gateway trusts only the CAs in that file, reads it at start (restart the
pods after a CA rotation), and connects to an IP address only if the
certificate names that IP. deploy/gcp does this with Memorystore.

## Exposing the gateway

The chart creates a ClusterIP service. Put your regional L7 load balancer or
ingress in front of it and point its health check at `/readyz`. For long
streamed completions, raise the load balancer's idle/response timeout to at
least `gateway.upstreamHeaderTimeout` plus `gateway.streamIdleTimeout`.

## Starting during a control plane outage

Each pod keeps the encrypted snapshot in an `emptyDir`, which survives a
container restart but not a new pod. With Valkey configured
(`quota.valkey.url`) and `STRATUM_SNAPSHOT_KEY` in `existingSecret`, the
gateways also keep the same encrypted snapshot in Valkey (ADR-0008). A pod
that starts while the control plane is unreachable waits
`snapshot.bootstrapTimeout` (10 s) for it, then serves the copy from Valkey.

Run Valkey next to the gateways, in the same cluster or network, never on the
far side of the link to the control plane: the point is that everything the
gateways need to start lives where they run. Without Valkey (or with
`snapshot.shared=false`), a pod that starts during an outage stays unready
until the control plane is back; pods that keep running are unaffected.

## Single-zone and development clusters

```sh
--set topologySpread.zoneWhenUnsatisfiable=ScheduleAnyway
```
