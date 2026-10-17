# Consumption

**Consumo** shows what gateways reported (ADR-0009), grouped by one
dimension: team, agent, person, model or provider.

- **Totals:** estimated cost, requests (share with an error, and how many a
  policy refused), tokens in and out, and p50/p95 latency.
- **Per day:** cost, requests or tokens, stacked for the five largest groups;
  the rest add up as "Otros". Days are UTC.
- **Table:** the same numbers per group, with the last request. A row opens
  its detail: a team by agent, an agent or person by model, a model by agent,
  a provider by model. The address keeps the selection
  (`/usage?agent=<id>&by=model`), and **Agentes** links each agent to its own.
- **Agents and people apart:** "por agente" counts only agent traffic and
  "por persona" only people's keys; teams, models and providers count both.
- **Who sees what:** the same as the rest of the usage views. A team manager
  sees their team only.

API: `GET /api/consumption?by=team|agent|user|model|provider` with the period
(`from`/`to` or `period`) and at most one filter (`team`, `agent`, `user`,
`model` as `provider/model`, `provider`). Permission `usage.read`.

Errors are 4xx and 5xx answers, refusals included. Refused by policy:
`no_policy`, `team_disabled`, `provider_not_allowed`, `model_not_allowed`,
`quota_exceeded`, `sensitive_data_detected`, `agent_model_mismatch`.

The cost is an estimate: tokens the provider reported × the catalog's list
price when the request was recorded. Requests to models outside the catalog
cost 0 here.
