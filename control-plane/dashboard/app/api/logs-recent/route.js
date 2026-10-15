export const dynamic = 'force-dynamic'
import { route, json } from '../../../lib/route.js'
import { logsScope } from '../../../lib/usage.js'

export const GET = route('logs.read', async (req, { session, db }) => {
  const params = []
  const where = logsScope(session, 'r', params)
  const { rows } = await db.query(`
    SELECT r.id, r.created_at, r.provider, r.model_id,
           r.tokens_input, r.tokens_output, r.cost_usd,
           r.latency_ms, r.auth_ms, r.policy_ms, r.provider_ms,
           r.trace_id, r.status_code,
           t.name  AS team_name,
           u.email AS user_email,
           a.name  AS agent_name
      FROM request_logs r
      LEFT JOIN teams  t ON t.id = r.team_id  AND t.org_id = r.org_id
      LEFT JOIN users  u ON u.id = r.user_id  AND u.org_id = r.org_id
      LEFT JOIN agents a ON a.id = r.agent_id AND a.org_id = r.org_id
     WHERE ${where}
     ORDER BY r.created_at DESC
     LIMIT 10
  `, params)
  return json(rows)
})
