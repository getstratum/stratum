# ADR-0014: External decision services

- **Status:** Accepted
- **Date:** 2026-11-02

## Context

Some rules about a request need more than the gateway's snapshot. For
example:

- an agent that repeats the same request in a loop;
- a budget per task rather than per team;
- an agent paused by hand while someone looks at what it did;
- an approval before a sensitive action.

Each of these needs state across requests and across gateway replicas, a
place to configure it, and sometimes its own release cycle. Putting each one
in the gateway grows the hot path and the binary for every operator. It also
ties every rule to the gateway's releases. And the open source gateway has
to carry rules that only some editions offer.

ADR-0001 keeps the gateway on the Go standard library, and ADR-0005 keeps
it serving when what it depends on fails.

## Decision

The gateway asks up to four **external decision services** about each
request, over HTTP/JSON (`docs/architecture/decision-services.md`):

1. **When the gateway asks.** After its own checks (key, policy, quota,
   PII/DLP) and just before it sends the request to the provider, it calls
   `POST {url}/v1/check` on every service at once.
2. **What a service gets.** Who made the request (key, team, person), the
   task the application named (`X-Stratum-Task`), the route, the labels,
   and a SHA-256 of the content. Never the text.
3. **What a service answers.** Allow, optionally adding labels and
   `X-Stratum-*` / `Retry-After` response headers. Or deny, with a status,
   a code and a message.
4. **How the answers combine.** The first deny, in the configured order,
   decides. Labels and headers from all the services that allowed are
   merged.
5. **When a service does not answer.** If a service misses the timeout
   (200 ms by default) or answers wrong, the gateway fails open: it sends
   the request and labels it `decision_skipped`. Failing closed (503
   `decision_unavailable`) is opt-in.
6. **Reports.** After each checked request, the gateway reports how it
   ended (status, tokens, time) to `POST {url}/v1/report`. Reports go in
   batches, off the request path, from a bounded buffer that drops and
   counts what does not fit, like usage records (ADR-0009).

## Alternatives considered

- **Rules compiled into the gateway.** No extra hop, but every rule makes
  the gateway bigger and depends on its release. Rules only some editions
  offer would need a build of the gateway per edition.
- **Go plugins or a public extension package.** Go plugins are fragile
  across toolchains. A public package would turn the gateway's internals
  into an API to keep stable.
- **Envoy's `ext_authz` protocol (gRPC).** Well known, but it brings in
  gRPC (ADR-0001), and it was designed for HTTP authorization, not for
  model requests.

## Consequences

- **Each rule is its own service.** It keeps its own state (shared across
  gateway replicas), its configuration and its release. It can move between
  editions without touching the gateway. Stratum Enterprise's agent guard is
  the first.
- **Latency.** A configured service adds one round trip on the same network
  to every request, bounded by the timeout. With none configured, nothing
  changes.
- **Content.** Services see what was asked only as a hash, so a loop can be
  detected without the text. A rule that needs the text (an injection
  classifier) would need an explicit opt-in that does not exist yet.
- **Telling the services apart.** Whether a service refuses or does not
  answer, it shows in the usage record (the code or `decision_skipped`), in
  `/metrics` (`stratum_decision_*`) and in the gateway's log.
