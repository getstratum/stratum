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

## From 0.9 to 1.0

- **Suspending an organization stops its gateways too**
  ([ADR-0020](adr/0020-organizations-and-the-operator.md)). The sync now
  says the organization's state; a gateway from 1.0 refuses every request
  of a suspended organization with **403 `org_suspended`**. Gateways
  before 1.0 ignore it and keep serving it: upgrade them. `stratum-admin`
  gains `org-list`, `org-suspend` and `org-resume`.

## From 0.8 to 0.9

0.9 is about measuring and governing agents by their results. Three
additive migrations; no setting to change.

- **An agent's tasks and how they end**
  ([ADR-0019](adr/0019-task-outcomes.md)). The `X-Stratum-Task` a request
  names (a model request or an MCP call) is now kept on its usage record
  (**migration 043**: `request_logs.task`, and the table
  `task_outcomes`). When a task ends, the application says how with
  `POST /v1/stratum/tasks/{task}` and its key: `{ "outcome": "resolved" |
  "escalated" | "failed", "reason": "<code>" }`, answered 202. The reason
  is a code (`customer_asked_for_a_person`), never a sentence: it is
  stored as usage metadata. The console shows each agent's results in
  Agentes (1, 7, 30 or 90 days), `GET /api/agents` says its last 30 days
  in `tasks_30d`, and `GET /api/agents/:id/tasks?days=` the detail. An
  application that never ends its tasks shows them open.
- **The version of an agent's instructions**: `X-Stratum-Agent-Version`
  (`v12`, `2026-11-18.1`, a commit) on its requests and on the end of its
  tasks, and the console cuts its results by version (**migration 044**).
  A malformed one (more than 64 characters, or anything but letters,
  digits and `. _ : -`) is **refused with 400 `invalid_agent_version`**:
  check what your agents send before you upgrade the gateways.
- **Each agent's last request**: Agentes and `GET /api/agents`
  (`last_request_at`, null after 90 days without one).
- **What each MCP server offers**
  ([ADR-0016](adr/0016-mcp-proxy.md#what-each-server-offers-from-09)):
  gateways list the tools of every MCP server turned on (`initialize`,
  `tools/list`, never a `tools/call`), with the server's credential, when
  the servers change and every `STRATUM_MCP_CATALOG_INTERVAL` (10 minutes;
  `0` turns it off), and report them to the console (**migration 045**:
  `tools`, `tools_error`, `tools_at`, `tools_gateway` on `mcp_servers`).
  So each gateway now reaches each server on its own, not only when an
  agent calls it: a server that logs or bills its connections sees them.
  Herramientas MCP shows each server's tools; `GET /api/mcp-servers`
  returns them (`providers.read`). The console still never calls a
  server.
- **The release workflow** fails when a chart cannot be pushed or tagged
  (0.8.0 was published with the gateway's chart untagged).

A 0.9 console works with 0.8 gateways: their agents have no tasks and the
MCP servers no tools until a 0.9 gateway reports them. A 0.8 console
would store each task's end a 0.9 gateway reports as one more request
(provider `stratum`, model `task`), and answer its MCP catalog with 404
(the gateway tries again later): upgrade the control plane first, as
always.

## From 0.7 to 0.8

- **MCP tool calls through the decision services**
  ([ADR-0017](adr/0017-tool-calls-decision-services.md)): with
  `STRATUM_DECISION_URLS` set, gateways ask the services about each
  `tools/call` the policy allows. A service that does not know tool calls
  sees a request with provider `mcp` and model `server/tool`. Their
  arguments go only with `STRATUM_DECISION_TOOL_ARGUMENTS=true` (chart:
  `decision.toolArguments`).
- **Requests:** a team refused an MCP server its policy does not allow is
  now recorded (model `server`, 403 `mcp_server_not_allowed`).
- **PII and DLP skip the ids and signatures of tool calls** (`tool_call_id`,
  a call's `id`, Gemini's `thought_signature`, the `signature` of a
  thinking block, the `encrypted_content` of a reasoning item): provider
  values sent back as they came, that the API key pattern mistook for keys.
  A call's arguments and every tool result are still scanned.
- **MCP tool calls fail closed** when the decision services do not answer
  (`STRATUM_DECISION_TOOL_FAIL=closed`, chart `decision.toolFailMode`),
  and wait for them up to a second (`STRATUM_DECISION_TOOL_TIMEOUT`,
  `decision.toolTimeout`). Model requests keep `STRATUM_DECISION_FAIL` and
  `STRATUM_DECISION_TIMEOUT`. For the previous behaviour, set
  `STRATUM_DECISION_TOOL_FAIL=open`.
- **Images and transcriptions** ([ADR-0018](adr/0018-images-and-transcriptions.md)):
  `/v1/images/generations` and `/v1/audio/transcriptions` (multipart) go
  through the policy, PII and DLP (the prompt), the decision services and
  Requests, priced per image and per minute of audio beside the tokens.
  **Migration 042**, additive: `images` and `audio_seconds` on
  `request_logs`; `cost_per_image` and `cost_per_audio_minute` on
  `ai_models` and `org_model_settings`. New `STRATUM_MAX_AUDIO_BYTES`
  (25 MiB). An image or a transcription without a model is refused
  (400 `model_required`): the policy's default model is for chat.
- **MCP requests take `X-Stratum-Labels`**, as model requests do: the
  labels go to the decision services and into Requests (the portal's
  `portal` and `with_tools` were lost). Malformed labels are refused with
  400 `invalid_labels`.
- **PII: a phone stands on its own.** Digits inside an identifier (an
  approval id like `ap_4088b3752e56`, a hash, a digest) are no longer
  redacted as a phone: the guard's approval id reached the person as
  `ap_[REDACTED:PHONE]6`.
- **DLP: names made of words are not keys.** The generic API key pattern
  (32+ letters, digits, `-` and `_`) now needs one stretch of 20+
  characters between `-` and `_` with letters and digits. Container, pod
  and release names (`stratum-demo-enterprise-stratum-gateway-1`), UUIDs
  and ids like `fc_<uuid>` no longer count as secrets: a team with
  `dlp_action: block` could not send the model the result of `docker ps`.
  Provider prefixes (`sk-`, `ghp_`, `AKIA`, `aig_`) and long random runs
  still count.
- **`GET /v1/stratum/mcp`:** the MCP servers a caller's policy allows,
  with the description written in the console (now in the sync too).
- **Migration 041, additive:** nullable `vision` and `tools` columns on
  `ai_models`, `provider_models` and `org_model_settings`: what a chat model
  can do besides text. Gateways say it in `GET /v1/models`
  (`capabilities`). Test each provider's connection again for what the
  providers say about it; until then, the catalog and the model's ID
  decide.

## From 0.6 to 0.7

- **Migration 040, additive:** the table `mcp_servers` and
  `policies.mcp_tools` (empty: no MCP server).
- **MCP tools for agents** ([ADR-0016](adr/0016-mcp-proxy.md)): gateways
  serve `/mcp/<server>`. Nothing changes until a server is added in
  *Herramientas MCP* and a policy allows its tools. Upgrade the gateways
  first: older ones answer 404 to `/mcp/`.
- **Inline images and PII:** gateways no longer scan base64 images and files
  that a request carries inline. Before, their digits could be flagged as a
  phone or a card, and redaction corrupted the image.

## From 0.5 to 0.6

- **Migration 038, additive:** a nullable `kind` column on `ai_models`,
  `provider_models` and `org_model_settings`. Nothing is backfilled: a
  model with no kind takes it from its ID.
- **Models have a kind** (chat, embeddings, images, speech to text, text to
  speech, moderation, other; [Kinds of model](console/providers-and-gateways.md#kinds-of-model)).
  The policy dialog opens on chat models; the others are one click away.
  Gateways of 0.6 say the kind in `GET /v1/models`; older ones leave it out,
  and clients that read it (the Enterprise portal) treat a model without
  one as chat.
- **Migration 039, additive:** `policies.default_model`,
  `request_logs.alias` (the route a request asked for, reported by 0.6
  gateways) and the table `default_model_notices`.
- **A policy can have a default model** ([Default model](console/providers-and-gateways.md#default-model)).
  Gateways before 0.6 ignore it: they neither mark it nor send model-less
  requests to it. Upgrade the gateways, then set defaults. Owners, Admins
  and team managers get an email when one stops working as set; set
  `STRATUM_SMTP_URL` if it is not.
- **Routes fall back on a 404** from the provider (the model is not there
  any more), not only on 429 and 5xx.
- **Test the connection again** to providers whose list says what each model
  is (Mistral, Together, OpenRouter): until then their models outside the
  catalog take the kind from their ID. Together's model list was read as
  empty before; it now lists its models.

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
