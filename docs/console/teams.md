# Teams, limits and alerts

Every person and every agent belongs to a team, and what a gateway enforces is
keyed by team: the team's policy decides which providers and models its keys
may use, and how many tokens per month.

## Teams

- Owners and Admins create teams from **Equipos** (`POST /api/teams`), rename
  them and change their policy. Names are unique within the organization,
  ignoring case.
- A team without a policy is refused by gateways (`no_policy`): create the
  policy first, or assign one right after creating the team.
- A team is deleted only when it is empty: people and agents are moved to
  another team first (`DELETE /api/teams/:id` answers 409 and says how many
  are left). Its alerts are deleted with it; its usage history stays, and the
  console counts it as "Equipo eliminado". Gateways drop the team on their
  next sync.
- Team managers see their own team and may change its budget only.

## What is enforced and what is not

| Setting | Where | Enforced by the gateway |
|---|---|---|
| Allowed providers and models | Policy | yes, on every request |
| Monthly token quota | Policy, per team | yes: past 100 % the team's requests are refused until the next month (ADR-0004) |
| Monthly budget (US$) | Policy, or the team's own | no: a reference the console compares spending against |
| Max tokens per request | Policy | no: stored, not sent to gateways yet |

A team's own budget, when set, takes the place of its policy's.

## Alerts

Alerts (a team, a threshold on its token quota or budget, an email address or
a Slack webhook) are stored and listed, but this version does not evaluate or
send them. The console says so on the Alertas page. Until then, follow the
quota and budget bars on **Equipos** and the figures in **Consumo**.
