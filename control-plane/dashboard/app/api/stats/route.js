export const dynamic = 'force-dynamic'
import { route, json } from '../../../lib/route.js'
import { parseDateRange, logsScope } from '../../../lib/usage.js'

export const GET = route('usage.read', async (req, { session, db }) => {
  const { from, to } = parseDateRange(new URL(req.url).searchParams)

  const p1 = [from, to]
  const s1 = logsScope(session, 'r', p1)
  const p2 = [from, to]
  const s2 = logsScope(session, 'r', p2)
  const p3 = [from, to, session.orgId]
  const teamFilter = session.scope === 'team' ? (p3.push(session.teamId), `AND t.id = $${p3.length}`) : ''

  const [totals, daily, teams] = await Promise.all([
    db.query(`
      SELECT COUNT(*)                                       AS total_requests,
             COALESCE(SUM(tokens_input + tokens_output), 0) AS total_tokens,
             COALESCE(SUM(cost_usd), 0)                     AS total_cost,
             COUNT(DISTINCT team_id)                        AS active_teams,
             SUM(impact_gwp_g_min)                          AS gwp_g_min,
             SUM(impact_gwp_g_max)                          AS gwp_g_max,
             COUNT(*) FILTER (WHERE impact_method IS NULL AND tokens_output > 0) AS impact_missing
        FROM request_logs r
       WHERE r.created_at >= $1 AND r.created_at <= $2 AND ${s1}
    `, p1),
    db.query(`
      SELECT TO_CHAR(DATE(created_at), 'DD/MM') AS day,
             COUNT(*)                           AS requests,
             COALESCE(SUM(cost_usd), 0)         AS cost
        FROM request_logs r
       WHERE r.created_at >= $1 AND r.created_at <= $2 AND ${s2}
       GROUP BY DATE(created_at)
       ORDER BY DATE(created_at)
    `, p2),
    db.query(`
      SELECT t.id AS team_id, t.name AS team_name, t.monthly_budget_usd AS team_budget,
             p.id AS policy_id, p.name AS policy_name, p.monthly_budget_usd,
             COUNT(r.id) AS total_requests,
             COALESCE(SUM(r.tokens_input + r.tokens_output), 0) AS total_tokens,
             COALESCE(SUM(r.cost_usd), 0) AS total_cost,
             COUNT(DISTINCT r.user_id) AS active_users
        FROM teams t
        LEFT JOIN policies p     ON p.id = t.policy_id AND p.org_id = t.org_id
        LEFT JOIN request_logs r ON r.team_id = t.id AND r.org_id = t.org_id
                                 AND r.created_at >= $1 AND r.created_at <= $2
       WHERE t.org_id = $3 ${teamFilter}
       GROUP BY t.id, t.name, t.monthly_budget_usd, p.id, p.name, p.monthly_budget_usd
       ORDER BY total_cost DESC
    `, p3),
  ])

  return json({
    totals: totals.rows[0],
    daily:  daily.rows.map(d => ({ day: d.day, requests: parseInt(d.requests), cost: parseFloat(d.cost) })),
    teams:  teams.rows,
  })
})
