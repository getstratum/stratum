# ADR-0017: MCP tool calls through the decision services

- **Status:** Accepted
- **Date:** 2026-11-16

## Context

Since 0.7 the gateway proxies MCP servers (ADR-0016): a team's policy says
which tools its agents may call, and each call is recorded. A policy says
yes or no to a tool. Organizations need more than that before an agent acts
on a real system:

- a person's approval before a sensitive tool (close a ticket, refund a
  payment, delete data);
- limits on what a tool may be called with (a refund up to an amount, a
  wiki search only in some spaces);
- the agent's own state: a paused agent should not act through its tools
  either, and a task's budget or a loop brake should see its tool calls.

Those rules need state across calls and replicas, a place to configure them
and someone to answer an approval. That is what decision services are for
(ADR-0014), and the agent guard already holds an agent's state.

## Decision

1. **Every call the policy allows is checked.** After the policy (ADR-0016)
   and before the call goes to the server, the gateway asks the decision
   services with the protocol of ADR-0014: `operation` `tool_call`,
   `provider` `mcp`, `model` `server/tool`, and a `tool` object with the
   server, the tool and the SHA-256 of its arguments. `tools/list`,
   `initialize` and the server's other methods are not checked.
2. **Arguments only when the operator says so.** They are what the agent
   sends and may hold data, unlike the model requests, whose text never goes
   (ADR-0014). `STRATUM_DECISION_TOOL_ARGUMENTS=true` sends them, up to
   16 KiB; past that, the hash alone. Without them a service can still
   match a call it saw, by the hash: an approval, a loop.
3. **A refusal is a tool result.** As for a tool the policy does not allow,
   the gateway answers the call itself, with `isError` and the service's
   message, so the agent's model reads why (waiting for an approval, an
   argument out of bounds) and can go on. Nothing reaches the server.
4. **Same records.** The usage record of a refused call has the service's
   status and code; allowed calls get the service's labels. Every checked
   call is reported (`/v1/report`) as it ended.

Approvals are asynchronous: a service that needs one refuses the call
(pending), a person decides elsewhere, and the agent calls again with the
same arguments; the service then lets that call through. The gateway holds
no call open while a person decides: a call can wait minutes or hours, and
an MCP client's request cannot.

## Alternatives considered

- **Rules on tools in the policy.** They would reach every gateway with the
  sync and need no extra service. But approvals need a store and people to
  answer, and rules on arguments grow into a language; both belong outside
  the gateway (ADR-0014).
- **Holding the call until a person decides.** Simpler for the agent, but
  it ties a connection, a gateway's memory and the agent's timeout to how
  fast a person answers.
- **Always sending the arguments.** Needed for rules on them and for
  approvers to see what they approve, but it sends data the operator may
  not want a service to see. Off by default; Stratum Enterprise's charts
  turn it on.

## Consequences

- Stratum Enterprise's agent guard decides on tool calls: approvals in the
  portal, rules on arguments, and its pause, task budget and loop brake
  for tools too.
- One more round trip per tool call when decision services are on, within
  their own timeout (`STRATUM_DECISION_TOOL_TIMEOUT`, a second by default).
- Tool calls fail closed by default (`STRATUM_DECISION_TOOL_FAIL=closed`),
  whatever `STRATUM_DECISION_FAIL` says for models: a tool acts, and an
  approval rule skipped because the service answered late is no rule. The
  0.8 tests showed it: the guard's first answer after a restart took over
  200 ms, the gateway sent the call, and the guard kept a request waiting
  for an approval of something already done. Refused, the agent reads
  that it was not made and may try again; `open` sends it labelled
  `decision_skipped`, as before.
- A service that does not know `tool_call` sees an ordinary request with
  provider `mcp`, and applies its rules to it.
