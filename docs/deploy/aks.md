# Stratum on Azure AKS

With `values-prod.yaml` and `platforms/aks.yaml`.

| | Service | Notes |
|---|---|---|
| Nodes | a node pool in zones 1, 2 and 3 | the gateways spread across them |
| Way in | the application routing add-on (managed NGINX) | certificate from Key Vault, 900 s reads |
| PostgreSQL | Azure Database for PostgreSQL flexible server 16, zone-redundant HA | `sslmode=require` |
| Valkey | Azure Cache for Redis, Standard or Premium, TLS only | `rediss://<name>.redis.cache.windows.net:6380/0` |
| Secrets | Key Vault through the External Secrets Operator and Workload Identity | `externalSecrets` |
| Network policies | Azure NPM or Cilium (Azure CNI powered by Cilium) | `ingressFrom`: `app-routing-system` |

## Install

```sh
az aks approuting enable -g <rg> -n <cluster>
helm install stratum oci://ghcr.io/getstratum/charts/stratum -n stratum --create-namespace \
  -f values-prod.yaml -f platforms/aks.yaml \
  --set global.domain=stratum.example.com \
  --set-string 'expose.annotations.kubernetes\.azure\.com/tls-cert-keyvault-uri=https://<vault>.vault.azure.net/certificates/stratum' \
  --set gateway.quota.valkey.url=rediss://stratum.redis.cache.windows.net:6380/0
```

Not yet installed on AKS by the project: rendered in CI.
