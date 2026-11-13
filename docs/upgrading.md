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

## From 0.4 to 0.5

Tested from 0.4.0: its migrations and the demo organization, then the 0.5
migrations on top (035 to 037 applied). The whole release was also run
end to end on Docker Desktop with real providers (Groq and Gemini, free
tiers) and the Enterprise portal: 34 cases, all passing after the fixes
they found (#111, #112, #113).

**What to know before you upgrade**

- **Three migrations (035 to 037), all additive.** A column with a default
  (035) and two new tables (036, 037); nothing is rewritten or backfilled.
- **Upgrade every gateway before you create routes.** A gateway before 0.5
  refuses `stratum/<name>` as an unknown provider. The console warns in
  *Modelos* while one of them is syncing. Decision services
  (`STRATUM_DECISION_URLS`) and traces (`OTEL_EXPORTER_OTLP_ENDPOINT`) are
  gateway settings, off until you set them.
- **Requests to a model without a price now have no cost, not 0.** Neither
  the organization's price nor the catalog's: `request_logs.cost_usd` is
  NULL, *Requests* says "Sin precio", the CSV leaves the cell empty, and
  *Consumo* leaves them out of the estimate and says how many. Rows logged
  before the upgrade keep their 0. If you query `request_logs` yourself,
  sum with `COALESCE(cost_usd, 0)` and count `cost_usd IS NULL` apart.
- **A route skips a provider it cannot reach.** With a next model, an error
  connecting is not retried; `STRATUM_UPSTREAM_CONNECT_TIMEOUT` (5 s, chart:
  `gateway.upstreamConnectTimeout`) bounds what an unreachable provider
  costs each request until its breaker opens.
- **PII redaction changed for overlapping matches.** A card number is no
  longer also flagged as a phone, and nothing of it is left in the text
  (0.4 could leave its last digits). Content flags of new requests show one
  type where 0.4 showed two.
- **Go 1.26.11** (GO-2026-6859 in `net/http`): if you build your own
  gateway image, build it with this toolchain or later.
- **New in the console, off until used:** service tokens (*Tokens de
  servicio*) and, per application, letting an Auditor read a person's
  history (*Aplicaciones*).
- **Docker Compose:** `git pull` and `make up`.

## From 0.2 to 0.3

Tested from 0.2.0: its migrations and the demo data, with request logs
already in place, then the 0.3 migrations on top (026 to 032 applied, old
rows kept as they were). A 0.3 control plane sends gateways fields that a
0.2 gateway ignores, so syncing keeps working while you upgrade them.

**What to know before you upgrade**

- **Eight migrations (025 to 032), all additive.** New columns and tables;
  nothing is rewritten. 026 backfills the month's usage per team for this
  month and the previous one from `request_logs`, so on a large table it
  takes a while; 032 does not estimate old requests (see below).
- **Upgrade every gateway before relying on what they enforce.** A 0.2
  gateway ignores, until it is replaced:
  budgets that cut and the maximum tokens per request (026, *Políticas*);
  instructions for people (031);
  `X-Stratum-User`: a request from a key that acts for people is served and
  counted as the agent's own, under the agent's team policy (028);
  `X-Stratum-Labels`: the request is served, without labels (029);
  and `GET /v1/models`. The console lists the versions each gateway reported
  in its last syncs (*Gateways*).
- **Alerts are now sent.** Active alerts, by email or Slack webhook, once
  per alert and month. Email needs `STRATUM_SMTP_URL`; webhooks go only to
  the hosts in `STRATUM_ALERT_WEBHOOK_HOSTS` (chart: `console.alerts.*`,
  default `hooks.slack.com`). Review your alerts before upgrading if some
  were set up only as a reference.
- **`STRATUM_CONSOLE_URL`** (chart: `console.publicUrl`), the console's
  public https address, is new: alert messages link to it, and it is the
  issuer when your own applications sign people in with their console
  account (OIDC, [applications](console/applications.md)). Without it,
  alerts have no links and OIDC is off.
- **Estimated environmental impact** is computed for requests reported
  after the upgrade. Requests already logged have none, and Consumo shows
  their emissions as missing rather than zero.
- **Kubernetes:** the gateway chart can install SLO burn-rate alerting
  rules (`PrometheusRule`), off by default.
- **Docker Compose:** `git pull` and `make up`.

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
