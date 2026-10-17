export const dynamic = 'force-dynamic'
import { route, json } from '../../../lib/route.js'

export const GET = route('teams.read', async (req, { session, db }) => {
  const team = session.scope === 'team'
  const { rows } = await db.query(
    `SELECT t.id, t.name, t.department, t.monthly_budget_usd,
            p.id AS policy_id, p.name AS policy_name, p.allowed_models,
            p.allow_all_models, p.allowed_providers
       FROM teams t
       LEFT JOIN policies p ON p.id = t.policy_id AND p.org_id = t.org_id
      WHERE t.org_id = $1 ${team ? 'AND t.id = $2' : ''}
      ORDER BY t.name`,
    team ? [session.orgId, session.teamId] : [session.orgId])
  return json(rows)
})
