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
| Monthly token quota | Policy, per team | yes: past 100 % the team's requests are refused until the next month (`quota_exceeded`, 429; ADR-0004) |
| Monthly budget (US$) | Policy, or the team's own | when the policy says so (*Cortar los pedidos al llegar al presupuesto*): past 100 % the team's requests are refused until the next month (`budget_exceeded`, 429). Otherwise a reference the console compares spending against |
| Max tokens per request | Policy | yes: a request that asks for more output tokens is lowered to the limit, and one that asks for none gets it (`X-Stratum-Max-Tokens` in the response says so). Empty: no limit |

A team's own budget, when set, takes the place of its policy's. When the
policy cuts at the budget, a team manager may lower the team's budget but
not raise it past the policy's.

### The month's usage, from the control plane

Gateways count tokens themselves, but one gateway does not see another's
traffic, a replica without Valkey counts on its own, and a restart starts
from zero. So with every sync the control plane sends each team's usage this
month as it counted it from every gateway's reports (`month_usage`, from
`team_usage_monthly`), and gateways use:

- for the token quota, the larger of their own count and the control
  plane's;
- for the budget, the control plane's spend: it prices usage with the
  organization's rates, gateways do not.

The control plane's count arrives about a minute late (usage is reported
every 10 s, synced every 30 s), so a team can go past a limit by what it
spends in that time. Until a gateway gets its first report of the month,
it does not enforce budgets (`stratum_month_usage_age_seconds` is -1).
Gateways before 0.3 enforce only their own token count; standalone gateways
(a configuration file, no control plane) never get a report, so they do not
enforce budgets.

## Alerts

Alerts (a team, a threshold on its token quota or budget, an email address or
a Slack webhook) are stored and listed, but this version does not evaluate or
send them. The console says so on the Alertas page. Until then, follow the
quota and budget bars on **Equipos** and the figures in **Consumo**.
