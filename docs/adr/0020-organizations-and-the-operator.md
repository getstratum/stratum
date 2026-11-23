# ADR-0020: Organizations, suspension and the operator

- **Status:** Accepted
- **Date:** 2026-11-23

## Context

One installation of Stratum can hold many organizations: every route of
the console checks the organization of the session, emails are unique
across the installation, and gateways belong to one organization each.
What is missing is someone to run them. Stratum Cloud needs a party that
creates organizations, gives each a plan, suspends one that stops paying
and deletes one that leaves, without seeing inside any of them: their
people, policies, credentials, requests and conversations are the
customer's.

`organizations.status` (`active` or `suspended`, migration 016) already
keeps the people of a suspended organization out of the console. It did
not stop its gateways: the sync never sent the state, so a suspended
organization kept using every model it had.

## Decision

- **The operator is a role outside every organization**, not an Owner
  with more rights. The interface calls it "Administración de Stratum".
  It creates organizations, invites their first Owner, sets their plan,
  suspends, resumes and deletes them, and reads each one's usage added
  up by month. It never sees people, policies, credentials, requests or
  conversations, and enters an organization only with the temporary
  access its Owner gives it, recorded in that organization's audit log.
- **What enforces is open source; the operator's console is
  Enterprise.** Suspension, plan limits, a platform API with its own
  token, invitations and support access go in the console and the
  gateway. `stratum-operator` (Enterprise) is the operator's console on
  top of that API, as the identity bridge is on top of service tokens: the
  open source console holds no paid code. An installation without
  Enterprise does the same with `stratum-admin`.
- **A suspended organization is refused everything.** The sync sends
  `organization: { status }` with every response, full or delta, not
  versioned. A gateway that has it suspended refuses every request of
  the organization's keys with 403 `org_suspended`, after the key is
  checked (a key that is not valid is still 401) and recorded as that
  key's and team's. The state is kept with the rest of the snapshot, so a
  gateway that restarts while its control plane is down stays suspended.
  A response without `organization` (a control plane before 1.0) leaves
  the last state as it was in a delta and means active in a full sync.
- **`stratum-admin org-suspend` and `org-resume`** change the state, with
  a reason kept in the organization's audit log; `org-list` lists the
  organizations. The console's sessions already check the state on every
  request, and gateways follow within one sync interval.
- **Deletion in two steps** comes next, with its own section here.

### Plan limits

- **The console gets the limits, not the plans.** `organizations.limits`
  (migration 046) holds the resolved ceilings; `plan_name` only names them
  for people. Named plans, and what each one costs, live with the operator
  (`stratum-operator` or the CLI). `org_profiles` (migration 016), reserved
  for this, stays unused: a plan that changes would have to change every
  organization on it at once, and a special deal is one organization's own
  limits anyway.
- **A missing limit is no limit**, so every organization upgrades to `{}`
  and nothing changes.
- **Counts are checked where they grow.** People and agents count when
  active, gateways when not disabled; creating one or turning one back on
  past the limit is refused with 409 `plan_limit` and a message that names
  the plan. The count and the insert run under one advisory lock per
  organization and kind, so two requests cannot both take the last place;
  people share the lock the people routes already take. Lowering a limit
  removes nothing.
- **Monthly tokens and spend are the gateway's, like a team's quota.** The
  sync sends them in `organization` (`monthly_token_quota`,
  `monthly_budget_usd`). The gateway keeps the organization's tokens as one
  more counter (`@org`, beside its teams', in memory or Valkey) and takes
  the control plane's count, the sum of its teams', as a floor and as the
  spend. Its codes are its own (`org_quota_exceeded`,
  `org_budget_exceeded`, 429), so a team that is under its quota knows the
  plan stopped it.
- **Retention is at least 31 days**, so the current month's figures in
  Consumo stay whole. The daily maintenance deletes `request_logs` and
  `task_outcomes` past it, in batches; `team_usage_monthly` stays.
- **Enterprise functions by plan** come with the licence per organization
  (stage 5), not here.

## Consequences

- Suspending takes effect in the console at once and in gateways within
  one sync interval. A gateway that cannot reach its control plane keeps
  serving with the state it had: suspension is not a kill switch for a
  disconnected gateway, the same as revoking a key.
- Gateways before 1.0 ignore the state and keep serving a suspended
  organization: upgrade them before relying on suspension.
- The usage of a suspended organization shows its refused requests, so
  its people see why their applications stopped.
