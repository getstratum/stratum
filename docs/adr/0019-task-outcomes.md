# ADR-0019: Tasks and how they end

- **Status:** Accepted
- **Date:** 2026-11-18

## Context

The console measures an agent by what it spends: requests, tokens, cost.
Whoever is in charge of agents measures one by its results: how many of
its tasks it resolves on its own, how many it hands over to a person, how
many fail, what each one costs and how long it takes. Since 0.5 a request
may name its task (`X-Stratum-Task`), but only the decision services see
it, and nothing says when a task ended or how.

## Decision

- **The task is kept on every request.** The gateway puts the
  `X-Stratum-Task` of a model request or an MCP call on its usage record
  (`task`, api/usage/v1); the control plane stores it in
  `request_logs.task` (migration 043). Without decision services a
  malformed task is still left out rather than refused, as before.
- **The application says how a task ended:** `POST
  /v1/stratum/tasks/{task}` with its key (a delegating key may name the
  person with `X-Stratum-User`), body `{ "outcome": "resolved" |
  "escalated" | "failed", "reason": "<code>" }`, answered 202. The reason
  is a code of 1 to 40 lowercase letters, digits and `_`
  (`customer_asked_for_a_person`), never a sentence: it is usage metadata,
  which holds no content. A task may end more than once (reopened, then
  resolved); the last end counts.
- **The end travels with the usage**, off the request path and at least
  once (ADR-0009): a usage record with `outcome` and `outcome_reason`,
  provider `stratum`, model `task`, reason `task_outcome`, no tokens. The
  control plane keeps it apart, in `task_outcomes`, owned as requests are:
  the organization is the reporting gateway's; a team, person or agent not
  in it is NULL. A control plane older than 0.9 ignores the new fields and
  stores the end as a request of `stratum/task` that costs nothing.
- **The console measures each agent** over 1, 7, 30 or 90 days (Agentes; `GET
  /api/agents` says its last 30 days in `tasks_30d`, `GET
  /api/agents/:id/tasks?days=` the detail): tasks that ended in the window
  by their last outcome; the share resolved on its own and escalated; cost
  per task and requests per task (its requests up to its end, looked for
  up to 30 days before the window); time from its first request to its
  end; why tasks were escalated or failed; and tasks with requests and no
  end, open.

## Consequences

- An agent gets a measure in the terms of whoever answers for it, and the
  Enterprise portal reads it with its service token for what it adds:
  comparing it with the metrics of the agent's card, warning or pausing it
  past a threshold.
- The measure is only as good as what the application says: an agent that
  never ends its tasks shows them all open, and the console says so.
  Stratum cannot tell a resolution from a claim of one; customer
  satisfaction and other measures of quality stay outside.
- A cost per task leaves out requests of models without a price, and says
  how many there were.
- `task_outcomes` is not partitioned. At the rate of tasks (not requests)
  that is fine for a long time; it is pruned like the rest when retention
  comes.
