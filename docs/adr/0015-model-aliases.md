# ADR-0015: Model aliases with fallback across providers

- **Status:** Accepted
- **Date:** 2026-11-09

## Context

Applications and agents name a concrete model in every request
(`openai/gpt-4o-mini`). That has two costs:

- **Changing a model means changing every application.** A platform team
  that wants its agents on a newer or cheaper model has to find and edit
  each one. The agent's fixed model (migration 021) solves it for one
  agent at a time, not for a kind of work.
- **A provider that is down stops every request that names it.** ADR-0010
  retries and pauses a failing provider (the breaker), and left open
  "failover to an equivalent deployment": it needs the console to say
  which models are equivalent, and belongs with model routing.

Tools for single developers (free-claude-code, for example) solve both with
model tiers and an ordered list of fallback models. The idea fits an
organization better than a developer: the platform team decides the list
once, and every application follows it.

## Decision

An organization defines **model aliases** in the console (Modelos → Rutas;
the catalog already calls a model's other IDs aliases):
a name and an ordered list of up to four targets, each a `provider/model`
of the organization's.

1. **How a request uses one.** `"model": "stratum/<name>"`. An agent can
   also have an alias as its fixed model (provider `stratum`). `stratum`
   is reserved: it is never a provider.
2. **Which targets a request may use.** The team's policy decides, as for
   any model: a target the policy does not allow, of a provider that is not
   configured, or in another API format than the request (Anthropic
   Messages or OpenAI-compatible) is left out. The policy does not list
   aliases. With no target left the request is refused, with the reason of
   the first target.
3. **When the gateway goes to the next target.** Only before anything
   reached the client: the provider's breaker is open, the connection
   fails or times out, or the provider answers 429, 500, 502, 503, 504 or
   529 after its own retries (ADR-0010). An error connecting is not
   retried when there is a next target: it goes there at once. Never after
   the first byte, and never on other answers (a 400 would fail
   everywhere). The gateway's log says why it moved on (`why`: the status,
   `paused`, `dns_error`, `dns_timeout`, `connect_timeout`,
   `connection_refused`, `connect_error`).
4. **What is recorded.** The usage record has the model that answered. The
   response says it in `X-Stratum-Routed-To`, and a request that went past
   its first target carries the label `routed_fallback`. Traces get
   `stratum.alias` and `stratum.fallbacks`.
5. **What the console checks.** Names of lowercase letters, digits, `.`,
   `_` and `-`; targets of providers the organization configured; all
   targets in the same API format.
6. **How gateways get them.** Like the model list: not versioned, sent with
   every sync, and the list in a response replaces the one the gateway had
   (`model_aliases`, sync protocol v2). A standalone config file can carry
   the same list.

`GET /v1/models` lists each alias the caller can use (at least one target
allowed) as `stratum/<name>`, before the models.

## Alternatives considered

- **Aliases in each policy.** Each team could map the same name to other
  models. More flexible, but the same name meaning different things per
  team makes usage hard to read, and most organizations want one
  definition. The policy still decides which targets each team may use.
- **Translating between API formats** (an Anthropic request to an
  OpenAI-compatible model), as free-claude-code does. Tool calls, thinking
  blocks and streaming events do not map one to one; a gateway that
  translates them changes what the model sees. Left out; the console keeps
  each alias in one format.
- **Spreading load across targets** (round robin, by price, by latency).
  A different problem; an alias is an order of preference.

## Consequences

- Changing the model behind an alias changes it for every application at
  the next sync, without touching them.
- A provider outage costs a request the time to fail over, not an error:
  a few milliseconds once the breaker is open. Before that, a provider that
  refuses connections costs a few milliseconds, and one that does not answer
  at all, up to `STRATUM_UPSTREAM_CONNECT_TIMEOUT` (5 s), once per request,
  until the breaker opens: connection errors are not retried when there is
  a next target. Answers that say "not now" (429, 502, 503, 504) are
  retried first (ADR-0010): a blip should not send traffic to a more
  expensive model. Found in the local test plan (12 Nov 2026), where an
  unreachable first target cost 5 to 7 s per request with a retry.
- Consumo shows the model that answered, not the alias. Usage by alias
  needs a field in the usage record; not done here.
- A fallback model may answer differently (tools, context window, quality).
  The console shows the targets in order; choosing equivalent ones is the
  organization's call.
- Gateways before 0.5 do not know aliases: `stratum/<name>` is refused as
  an unknown provider. The console warns while it has older gateways.
