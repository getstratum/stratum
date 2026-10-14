# Helm chart: stratum-gateway

Highly available reference deployment of the Stratum gateway (data plane),
following [docs/architecture/overview.md](../../docs/architecture/overview.md).

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

## Exposing the gateway

The chart creates a ClusterIP service. Put your regional L7 load balancer or
ingress in front of it and point its health check at `/readyz`. For long
streamed completions, raise the load balancer's idle/response timeout to at
least `gateway.upstreamHeaderTimeout` plus `gateway.streamIdleTimeout`.

## Known limitation

The encrypted snapshot lives in an `emptyDir`. Pods that keep running are
unaffected by a control plane outage, but a pod rescheduled during one starts
without configuration and stays unready (and out of the load balancer) until
the control plane is back. Signed snapshots in object storage, which remove
this gap, are on the roadmap (ADR-0003).

## Single-zone and development clusters

```sh
--set topologySpread.zoneWhenUnsatisfiable=ScheduleAnyway
```
