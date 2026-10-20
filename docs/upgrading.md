# Upgrading

Upgrade the **control plane first, then the gateways**. A control plane
works with gateways of the previous release, and its migrations work with
the console of the previous release, so neither step needs downtime.
Gateways newer than their control plane are not tested.

Migrations are applied by the control plane chart (an init container in
every pod), by `make up` with Docker Compose, or by you with the
`stratum-migrations` image of the same version
([chart README](../deploy/helm/stratum-control-plane/README.md#migrations)).
Back up the database before you upgrade.

## From 0.1 to 0.2

Tested from 0.1.1 with real processes: the 0.2 migrations on a 0.1.1
database while the 0.1.1 console kept serving, the 0.2 console in its
place with a 0.1.1 gateway still running (sync, requests and usage kept
working), and the 0.2 gateway replacing it while the control plane was
down (it started from the snapshot the 0.1.1 gateway had written).

**What to know before you upgrade**

- **One migration (024), additive.** New tables for the live model
  catalog and per-organization model settings; nothing is rewritten.
- **Models turned off apply only on 0.2 gateways.** Modelos can turn a
  model off for the whole organization (`model_disabled`, 403). A 0.1
  gateway ignores the switch and keeps serving that model until it is
  upgraded: upgrade every gateway before relying on it.
- **The console reads a model catalog feed once a day** from
  `https://raw.githubusercontent.com/getstratum/stratum/main/catalog/models.json`
  (ADR-0012). It is the only call the control plane makes to the internet
  on its own. Point `STRATUM_MODEL_CATALOG_URL` (chart:
  `console.modelCatalogUrl`) at an https mirror, or set it to `off` and
  apply the catalog by hand
  ([without internet access](../deploy/helm/stratum-control-plane/README.md#without-internet-access)).
- **New image: `ghcr.io/getstratum/stratum-migrations`.** If you mirror
  images, mirror this one too, with the same tag as the console.
- **Kubernetes:** the control plane has its own Helm chart now
  (`oci://ghcr.io/getstratum/charts/stratum-control-plane`). If you ran it
  from your own manifests, install the chart with the same secret
  (`DATABASE_URL`, `STRATUM_ENCRYPTION_KEY`) and remove your Deployment;
  gateways keep serving while the console is replaced.
- **deploy/gcp:** `make deploy` replaces the Deployment of an earlier kit
  with the chart by itself (the console is down about a minute).
- **Docker Compose:** `git pull` and `make up`.

What is new for users is in the [changelog](../CHANGELOG.md).
