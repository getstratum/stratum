# ADR-0016: MCP tools through the gateway

- **Status:** Accepted
- **Date:** 2026-11-15

## Context

Agents act through tools. The Model Context Protocol (MCP) is how most of
them reach those tools: a ticketing system, a wiki, a database, an internal
API. The gateway already decides which models a team may use, and records
every request. An agent's tools were outside of all that:

- each agent held each tool server's credential;
- any agent that reached a server could call any of its tools;
- nothing recorded which tool was called, by whom.

A model request and a tool call carry the same governance questions (who,
what, allowed, how much). Agents already authenticate to the gateway with
their Stratum key.

## Decision

The gateway proxies MCP servers that the organization registers in the
console (*Herramientas MCP*):

1. **Where.** `<gateway>/mcp/<name>`, MCP's Streamable HTTP transport: JSON-
   RPC messages POSTed to one endpoint, answered with JSON or server-sent
   events; GET opens a stream for the server's own messages; DELETE ends a
   session. Session and protocol headers pass through.
2. **Who.** The agent uses its Stratum key (`Authorization: Bearer`), with
   `X-Stratum-User` when its key acts for people, as for a model request.
   The server's credential (one header, kept encrypted in the console)
   travels with the sync and is added by the gateway. Agents never see it,
   and the agent's key never reaches the server.
3. **What a policy allows.** `mcp_tools`: `server/*` (every tool of that
   server) or `server/tool`. Empty, no server: a new surface is closed until
   someone opens it.
4. **Enforced on the call.** A `tools/call` to a tool the policy does not
   allow is answered by the gateway as a tool result with `isError`, which
   the agent's model reads and can work around; nothing reaches the server.
   A batch (MCP before 2025-06-18) that holds one is refused whole.
5. **Courtesy on the list.** The answer to `tools/list` leaves out the tools
   the policy does not allow, as JSON or inside events. A list that comes
   another way (an event split across several `data:` lines) goes as it
   is: the call is what is enforced.
6. **Recorded.** Each `tools/call` is a usage record: provider `mcp`, model
   `server/tool`, label `mcp`, status, refused ones included (403,
   `tool_not_allowed`). So is a request refused because the policy does not
   allow the server at all (model `server`, 403, `mcp_server_not_allowed`,
   from 0.7.1): a team trying a server it may not use is what an audit looks
   for. The console shows them in Requests.

### What each server offers (from 0.9)

Whoever administers the servers needs to see their tools, whatever their own
team's policy lets them use: to write a policy, or to mark in Enterprise
which tools only read. The console never calls the servers: they are in the
gateways' network, and an address an administrator types is not one the
console should reach. So each gateway lists them (`initialize`,
`tools/list`, never a `tools/call`), with the server's credential, when its
list of servers changes and every `STRATUM_MCP_CATALOG_INTERVAL` (10 minutes),
and reports the result to `POST /api/internal/mcp-catalog` with its sync
token: each server's tools (name, description, what the server says with
`readOnlyHint`, a hint and not a guarantee), or why they could not be
listed. The console keeps the last report of each server and returns it in
`GET /api/mcp-servers` (`providers.read`).

### Open source and Enterprise

In the open source edition: the proxy, the servers, the per-policy list of
tools, the records. In Enterprise, through decision services (ADR-0014) and
not in the gateway: rules on a tool's arguments, a person's approval before
a sensitive tool, a budget per task that counts tool calls. The gateway will
ask the decision services about `tools/call` the way it asks about model
requests, with the tool and its arguments: [ADR-0017](0017-tool-calls-decision-services.md).

## Consequences

- One place to give an agent a tool, change its credential, or take it
  away, without touching the agent.
- The gateway reads the JSON-RPC messages an agent sends, not the server's
  answers but for `tools/list`. A server's other methods (resources,
  prompts, sampling) pass through unchecked, and so does stdio: a server
  that only speaks stdio needs an HTTP bridge in front of it.
- Gateways before 0.7 answer 404 to `/mcp/`; control planes before 0.7
  send no servers. A policy's `mcp_tools` is ignored by older gateways,
  which have no MCP route at all.
- The console never calls the servers: their addresses are typed by an
  administrator and may point anywhere in the customer's network. A server
  is tested from an agent, through a gateway.
