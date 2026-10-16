# ADR-0010: Retries before the first byte and a circuit breaker per provider

- **Status:** Accepted
- **Date:** 2026-10-16

## Context

The failure tests (docs/testing) show the gateway itself producing no
errors through rollouts, zone losses and control plane or database
outages. In production the most frequent failure is elsewhere: the AI
provider answers 503 or 429 for a while, resets connections, or stops
answering. Two things went wrong then:

- One bad answer reached the client even when trying again a moment later
  would have worked. Clients that retry (the official SDKs do) recover;
  the rest do not.
- A provider that stops answering held every request to it until
  `STRATUM_UPSTREAM_HEADER_TIMEOUT` (120 s): connections, memory and the
  concurrency limit (`STRATUM_MAX_INFLIGHT`) filled up with requests that
  could only fail, and requests to healthy providers were shed with them.

## Decision

1. **Retry while nothing has reached the client.** A request is sent again
   (up to `STRATUM_UPSTREAM_RETRIES`, 2) after an error connecting (refused,
   DNS), or a 429, 502, 503 or 504 answer, with exponential backoff and
   jitter or the provider's `Retry-After`. Not after a timeout (the time is
   already spent), a connection that broke after the request was written
   (the provider may be running it, and a generation is billed), a 500 or
   any other answer (it may come from the request itself). Once the first
   byte is on its way to the client, nothing is retried: a stream cannot be
   resumed transparently.
2. **Bounded.** The waits of one request add up to at most
   `STRATUM_UPSTREAM_RETRY_MAX_WAIT` (5 s), and a provider's `Retry-After`
   longer than that is not waited out: the client gets the answer and its
   `Retry-After`. Every retry spends a token from a budget that grows by
   `STRATUM_RETRY_BUDGET_RATIO` (0.2) per request plus one per second, so
   retries stay a fifth of the traffic: when a provider is truly down, the
   gateway does not multiply the load on it.
3. **A circuit breaker per provider configuration.** After
   `STRATUM_BREAKER_THRESHOLD` (5) failures of the provider in a row
   (connection errors, timeouts, 5xx, a stream that stalls or breaks after
   its headers: a response counts once it has been read to the end), requests to it
   are answered at once with 503 `provider_unavailable` and `Retry-After`,
   for `STRATUM_BREAKER_COOLDOWN` (30 s). Then one request goes through as a
   probe: if it works the breaker closes, if not it opens again. A 429 never
   counts: rate limits are about the caller, not the provider's health.
   Breakers are per gateway replica, in memory; each learns on its own.
4. Usage is reported once per client request, for the attempt that
   answered; quotas count the tokens of that answer only.

Metrics: `stratum_upstream_retries_total`,
`stratum_upstream_retry_budget_exhausted_total`,
`stratum_provider_breaker_trips_total`,
`stratum_provider_breaker_rejections_total`.

## Not decided here

**Failover to an equivalent deployment** (another region of Azure OpenAI,
the same model at another provider) needs the console to say which
deployments are equivalent; today an organization has one configuration per
provider. It belongs with model routing, where a policy chooses among
models, and is designed there. The breaker is what makes it possible: the
503 it answers is the signal to use the alternative.

## Consequences

- A burst of 503s from a provider is mostly invisible to clients.
- A provider that is down costs each request a few milliseconds instead of
  two minutes, and stops taking capacity from the others.
- Clients that also retry multiply attempts (SDK retries × gateway
  retries). The budget and the breaker bound that; the gateway's retries
  are fast and few, the SDK's slower.
- A request that the provider received but whose answer was lost (a reset
  after the request was written) is not retried here: the client gets a
  502 and decides. The SDKs retry those, accepting that the provider may
  run the request twice; the gateway does not add a second layer of that
  risk.
