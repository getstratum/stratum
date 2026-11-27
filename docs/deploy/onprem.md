# Stratum on premise

Kubernetes you run (kubeadm, RKE2, k3s, Rancher, Tanzu...), with
`values-prod.yaml` and `platforms/onprem.yaml`.

## What the cluster needs

| | Suggested | Why |
|---|---|---|
| Nodes | 3 or more, in 3 failure domains (racks, hosts) labelled `topology.kubernetes.io/zone` | the gateways spread across them |
| Load balancer | MetalLB, or your hardware in front of the nodes | ingress-nginx's Service |
| Ingress | ingress-nginx | the console and the API, 15-minute reads for streams |
| Certificates | cert-manager with your CA or ACME | `expose.tls.clusterIssuer` |
| Volumes | a replicated StorageClass (Ceph RBD, Longhorn, your SAN's CSI) | PostgreSQL and Valkey |
| PostgreSQL | the CloudNativePG operator | 3 instances, automatic failover |
| Object storage | MinIO or Ceph RGW (S3) | the database's backups and WAL |
| Network policies | Calico or Cilium | the NetworkPolicies are enforced |
| Secrets | External Secrets Operator with Vault | `externalSecrets` |

Without zone labels, set `gateway.topologySpread.zoneWhenUnsatisfiable:
ScheduleAnyway`: otherwise the gateways stay Pending.

## Install

```sh
kubectl create namespace stratum
kubectl label namespace stratum pod-security.kubernetes.io/enforce=restricted
# The database's user, and the bucket's keys for its backups
kubectl -n stratum create secret generic stratum-postgresql --type=kubernetes.io/basic-auth \
  --from-literal=username=stratum --from-literal=password="$(openssl rand -hex 24)"
kubectl -n stratum create secret generic stratum-cnpg-backup \
  --from-literal=ACCESS_KEY_ID=... --from-literal=ACCESS_SECRET_KEY=...
kubectl -n stratum create secret generic stratum-valkey --from-literal=default="$(openssl rand -hex 24)"
# stratum-control-plane and stratum-gateway: see deploy/helm/stratum/README.md (Production)

helm install stratum oci://ghcr.io/getstratum/charts/stratum -n stratum \
  -f values-prod.yaml -f platforms/onprem.yaml \
  --set global.domain=stratum.example.com \
  --set expose.tls.clusterIssuer=internal-ca \
  --set cnpg.backups.endpointURL=https://minio.example.com
```

`DATABASE_URL` in `stratum-control-plane`:
`postgresql://stratum:<password>@stratum-cnpg-rw:5432/stratum`.

## Check

```sh
kubectl -n stratum get pods -o wide        # gateways on different nodes
kubectl -n stratum get clusters.postgresql.cnpg.io
helm test stratum -n stratum               # NetworkPolicies enforced
```

Practise the failures before relying on them: drain a node with a gateway
and a database instance (`kubectl drain`), and restore the database into a
new cluster from the bucket (CloudNativePG's `bootstrap.recovery`).
