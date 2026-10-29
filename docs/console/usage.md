# Consumption

**Consumo** shows what gateways reported (ADR-0009), grouped by one
dimension: team, agent, application, person, model, provider or label.

- **Totals:** estimated cost, requests (share with an error, and how many a
  policy refused), tokens in and out, p50/p95 latency, and estimated
  emissions (see below).
- **Per day:** cost, requests or tokens, stacked for the five largest groups;
  the rest add up as "Otros". Days are UTC.
- **Table:** the same numbers per group, with the last request. A row opens
  its detail: a team by agent, an agent or person by model, an application
  by person, a model by agent, a provider by model, a label by person. The
  address keeps the selection (`/usage?agent=<id>&by=model`), and **Agentes**
  links each agent to its own (an agent that acts for people, to
  `/usage?app=<id>`).
- **Agents and applications apart:** both are agents' keys. "Agentes" counts
  what an agent does on its own (no person); "Aplicaciones" what a key that
  acts for people did on behalf of someone (`X-Stratum-User`: a chat portal,
  say), with how many people. That use is also each person's, in
  "Personas", and their team's, never the agent's team. A team manager sees
  their people's use of an application, by its name.
- **People:** "por persona" counts people's own keys and what applications
  did for them; teams, models and providers count everything.
- **Labels:** what applications put on their requests with the
  `X-Stratum-Labels` header (a chat portal, the topic of each message; an
  agent, the feature that made the call). A request with two labels counts
  in both rows, so the rows can add up to more than the totals, which count
  each labelled request once. Labels are kept apart from PII findings.
- **Who sees what:** the same as the rest of the usage views. A team manager
  sees their team only.

API: `GET /api/consumption?by=team|agent|app|user|model|provider|label` with
the period (`from`/`to` or `period`) and at most one filter (`team`, `agent`,
`app`, `user`, `model` as `provider/model`, `provider`, `label`). Rows by
`app` carry `people`. Permission `usage.read`.

Errors are 4xx and 5xx answers, refusals included. Refused by policy:
`no_policy`, `team_disabled`, `provider_not_allowed`, `model_not_allowed`,
`quota_exceeded`, `sensitive_data_detected`, `agent_model_mismatch`,
`model_disabled`.

The cost is an estimate: tokens the provider reported × the price when the
request was recorded: the organization's own price for that model if it set
one in Modelos, the catalog's list price otherwise. Requests to models
without either cost 0 here.

## Environmental impact (estimated)

Each request also gets an estimate of its environmental impact when its
usage arrives: energy (Wh, datacenter overhead included), emissions (g
CO2eq: the electricity plus the request's share of making the hardware),
water (mL), primary energy (kJ) and abiotic resource depletion (mg Sb eq).
They are stored in `request_logs` (`impact_*`, migration 032) and shown:

- **Consumo:** a tile with the period's emissions (the middle of the range,
  the range, energy and water), a CO2e measure for the daily chart, and a
  column per group. A group whose requests lack an estimate says so (an
  asterisk, "sin dato"); it never counts them as zero.
- **Modelos:** each model's emissions per 1,000 output tokens, beside its
  price, to compare models for the same job.
- **Inicio:** the period's emissions.

`GET /api/consumption` returns them as `impact` on the totals and on each
row: `gwp_g`, `energy_wh` and `water_ml` as `{min, max}` (null when nothing
in the group has an estimate), `estimated` and `missing` (requests with
output and no estimate), and `co2` (the middle, in g) per day.

- **Method:** [EcoLogits](https://github.com/mlco2/ecologits), a life cycle
  assessment of model inference (ISO 14044), ported to the console with its
  data (`control-plane/dashboard/lib/impacts`, MPL-2.0). It uses what
  gateways already report: provider, model, output tokens and duration.
- **A range, not a number:** closed models do not publish their size, so
  each figure has a low and a high end (`_min`, `_max`), equal when the
  model is known exactly.
- **No estimate, not zero:** a model EcoLogits does not know (a custom or
  local one) or a request without output gets NULL.
- **Where:** the datacenter's country and efficiency per provider, as
  EcoLogits has them (OpenAI, Anthropic, Google: USA; Mistral: Sweden).
  Azure OpenAI takes OpenAI's figures; open models served by any provider
  (Groq, Together...) take those of Hugging Face.
- **Not counted:** model training, the network, people's devices, the
  datacenter building, the hardware's end of life, and input tokens (a long
  prompt with a short answer is underestimated).
- **Versioned:** `impact_method` (e.g. `ecologits-0.11.3`) says which
  method and data made each estimate. An update applies from its date;
  stored rows are not recomputed.
