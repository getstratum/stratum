# Helm chart: stratum-gateway

Highly available reference deployment of the Stratum gateway (data plane),
following [docs/architecture/overview.md](../../docs/architecture/overview.md).
The control plane has its own chart:
[stratum-control-plane](stratum-control-plane/README.md).

What the defaults give you:

| Concern | Default |
|---|---|
| Kubernetes | 1.29 or later |
| Replicas | 3 minimum (HPA 3–12 on CPU, needs the metrics API); the chart refuses fewer than 2 |
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

## Metrics

`/metrics` on the admin port (`metrics.port`, a Service of its own;
`metrics.serviceMonitor.enabled` for the Prometheus Operator). Among them:

| Metric | |
|---|---|
| `stratum_requests_total{code,provider,reason}` | Every request, refused ones included; `reason` is a short code (`ok`, `quota_exceeded`, `upstream_status`, ...) |
| `gen_ai_client_operation_duration_seconds` | Histogram of requests sent to a provider, streams to their end. OpenTelemetry `gen_ai.client.operation.duration` |
| `gen_ai_client_token_usage` | Histogram of tokens per request, `gen_ai_token_type="input"` or `"output"`. OpenTelemetry `gen_ai.client.token.usage` |
| `stratum_snapshot_age_seconds` | Seconds since the control plane last confirmed the configuration |
| `stratum_upstream_retries_total`, `stratum_provider_breaker_trips_total` | Provider failures (ADR-0010) |

The `gen_ai_*` histograms follow the OpenTelemetry semantic conventions for
generative AI, under the names an OpenTelemetry Collector gives them in
Prometheus, with `gen_ai_operation_name`, `gen_ai_provider_name` (the
conventions' value where there is one: `azure.ai.openai`, `gcp.gemini`, ...),
`gen_ai_request_model` and, for failures, `error_type` (the provider's HTTP
status, or the gateway's reason). The model comes from the request: past
1,000 label sets, new models are counted as `_other`.

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

## Alerting rules (SLO)

`metrics.prometheusRule.enabled=true` installs a `PrometheusRule` (Prometheus
Operator) for this release's gateways:

| Alert | Severity | When |
|---|---|---|
| `StratumGatewayErrorBudgetBurn` | critical | The gateway's own 5xx spend the availability error budget fast: 14.4× the allowed rate over 1 h and 5 min, or 6× over 6 h and 30 min |
| `StratumGatewayErrorBudgetBurnSlow` | warning | 3× over 1 day and 2 h, or 1× over 3 days and 6 h |
| `StratumGatewayConfigurationStale` | warning | A gateway has not confirmed its configuration for `snapshotMaxAgeSeconds` (900) |
| `StratumGatewayUsageDropped` | warning | Usage records were lost in the last 15 minutes |
| `StratumGatewayQuotaStoreDown` | warning | The shared quota store (Valkey) has not answered for a minute |

The SLI is the one in [docs/architecture/overview.md](../../docs/architecture/overview.md):
requests, 4xx left out, not answered with a 5xx of the gateway's own. A 5xx
whose reason is in `providerReasons` (`upstream_status`, `upstream_timeout`,
`provider_unavailable`, ...) is the provider's and does not count. The
target is `availabilityTarget` (0.9999). Recording rules
`stratum:gateway_errors:ratio_rate{5m,30m,1h,2h,6h,1d,3d}` keep the ratio
per namespace and job for dashboards. By default the rules select the
namespace and the job Prometheus gives the metrics Service
(`<release>-stratum-gateway-metrics`); set `selector` to other PromQL label
matchers if you scrape it differently. CI checks the rules with `promtool`
and tests them with synthetic series (`tests/prometheusrule.test.yaml`).

## Single-zone and development clusters

Replicas are spread across zones with `DoNotSchedule`: a replica stays
pending rather than leave a zone without one. A node without the
`topology.kubernetes.io/zone` label cannot satisfy that, so on a cluster
whose nodes have no zone (kind, minikube, kubeadm, many on-premises
clusters) every replica stays pending, with *didn't match pod topology
spread constraints (missing required label)*. There, and on single-zone
clusters:

```sh
--set topologySpread.zoneWhenUnsatisfiable=ScheduleAnyway
```

## Autoscaling

The HorizontalPodAutoscaler (on by default) scales on CPU through the
metrics API, which metrics-server or your provider serves; it is not part
of every cluster. Without it the gateway keeps `autoscaling.minReplicas`
replicas and does not scale: `kubectl get hpa` shows `<unknown>` targets.
Install metrics-server, or set `autoscaling.enabled=false` and
`replicaCount`.
