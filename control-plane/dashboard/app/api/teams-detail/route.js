export const dynamic = 'force-dynamic'
import { route, json } from '../../../lib/route.js'

export const GET = route('usage.read', async (req, { session, db }) => {
  const team = session.scope === 'team'
  const { rows } = await db.query(`
    SELECT
      t.id, t.name, t.department, t.monthly_budget_usd AS team_budget,
      p.name AS policy_name, p.allowed_models,
      p.monthly_token_quota, p.monthly_budget_usd AS policy_budget,
      (SELECT count(*) FROM users u WHERE u.team_id = t.id AND COALESCE(u.is_active, true)) AS total_users,
      COUNT(r.id)                                        AS requests_month,
      COALESCE(SUM(r.tokens_input + r.tokens_output), 0) AS tokens_month,
      COALESCE(SUM(r.cost_usd), 0)                       AS cost_month
    FROM teams t
    LEFT JOIN policies p     ON p.id = t.policy_id AND p.org_id = t.org_id
    LEFT JOIN request_logs r ON r.team_id = t.id
                             AND r.org_id = t.org_id
                             AND r.created_at >= date_trunc('month', now())
    WHERE t.org_id = $1 ${team ? 'AND t.id = $2' : ''}
    GROUP BY t.id, p.name, p.allowed_models, p.monthly_token_quota, p.monthly_budget_usd
    ORDER BY cost_month DESC
  `, team ? [session.orgId, session.teamId] : [session.orgId])
  return json(rows)
})
