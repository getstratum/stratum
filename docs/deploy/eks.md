# Stratum on Amazon EKS

With `values-prod.yaml` and `platforms/eks.yaml`.

## AWS pieces

| | Service | Notes |
|---|---|---|
| Nodes | managed node groups in 3 Availability Zones | the gateways spread across them |
| Way in | AWS Load Balancer Controller, an ALB (`className: alb`) | one ALB for both hosts (`group.name`), 900 s idle timeout, certificate from ACM |
| PostgreSQL | RDS for PostgreSQL 16, Multi-AZ | `sslmode=verify-full` with the RDS CA bundle in `DATABASE_URL` |
| Valkey | ElastiCache for Valkey, cluster mode off, a replica, in-transit encryption | `gateway.quota.valkey.url: rediss://master.<name>...:6379/0` |
| Secrets | Secrets Manager, read by the External Secrets Operator through IRSA or Pod Identity | `externalSecrets.secretStoreRef` |
| Network policies | the VPC CNI's network policy agent (`enableNetworkPolicy: "true"`) | `ingressFrom`: the VPC's CIDR (target-type ip) |

## Install

```sh
helm install stratum oci://ghcr.io/getstratum/charts/stratum -n stratum --create-namespace \
  -f values-prod.yaml -f platforms/eks.yaml \
  --set global.domain=stratum.example.com \
  --set-string 'expose.annotations.alb\.ingress\.kubernetes\.io/certificate-arn=arn:aws:acm:...' \
  --set gateway.quota.valkey.url=rediss://master.stratum.xxxxxx.use1.cache.amazonaws.com:6379/0 \
  --set 'networkPolicy.ingressFrom[0].ipBlock.cidr=10.20.0.0/16' \
  --set 'gateway.gateway.trustedProxies={10.20.0.0/16}'
```

Then point `consola.` and `gateway.` at the ALB (Route 53 alias).

Not yet installed on EKS by the project: rendered in CI.
