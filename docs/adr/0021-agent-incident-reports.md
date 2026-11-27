# ADR-0021: An agent reports a problem through the gateway

- Status: accepted
- Date: 2026-11-27

## Context

People report a problem with the AI from the portal's chat («Reportar un
problema»); Stratum Enterprise keeps it in Incidentes (ISO/IEC 42001 A.3.3,
A.8.3). An agent may notice a problem too: a tool that answers wrong, a
customer who says the answer harmed them, a result it cannot trust. It had
no way to say so but to end a task as `escalated`, which counts, and says
nothing.

An agent already holds a key and talks to the gateway. Stratum Enterprise
is often internal, and does not know agents' keys.

## Decision

`POST /v1/stratum/incidents` on the gateway, with the agent's key and
`{ "what", "about", "task" }`. The gateway authenticates the key as for any
request (an organization suspended, a key revoked: refused), and passes
the report to `{STRATUM_INCIDENTS_URL}/api/internal/incidents` with the
key's agent, team and person, under `STRATUM_INCIDENTS_TOKEN`. Stratum
Enterprise trusts the identity because it trusts the gateway's token, as
the guard trusts the gateway for decisions (ADR-0014).

- The agent holds no second secret and only needs to reach the gateway.
- What it wrote reaches Stratum Enterprise only, which seals it as it does
  the portal's reports; the usage record says that the agent reported,
  never what.
- Stratum Enterprise limits reports per agent per hour and answers 429;
  the gateway passes its refusal on.
- A person's key, or a delegating key naming a person, reports too: the
  identity goes as it is.

## Considered

- The agent calls Stratum Enterprise with its key, and Stratum Enterprise
  asks the console whose it is: no new secret, but every agent must reach
  Stratum Enterprise, and the console needs an API to resolve keys.
- A token per agent issued by Stratum Enterprise: self-contained, but one
  more secret per agent to keep and rotate.
