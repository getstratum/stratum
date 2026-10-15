export const dynamic = 'force-dynamic'
import { route, json, badRequest, isUuid } from '../../../lib/route.js'
import { parseDateRange, logsScope } from '../../../lib/usage.js'

export const GET = route('logs.read', async (req, { session, db }) => {
  const sp = new URL(req.url).searchParams
  const params = []
  const conditions = [logsScope(session, 'r', params)]
  const add = (sql, value) => { params.push(value); conditions.push(sql.replace('?', `$${params.length}`)) }

  if ((sp.get('from') && sp.get('to')) || sp.get('period')) {
    const { from, to } = parseDateRange(sp)
    add('r.created_at >= ?', from)
    add('r.created_at <= ?', to)
  }
  const team = sp.get('team')
  if (team) {
    if (!isUuid(team)) throw badRequest('Equipo inválido.')
    add('r.team_id = ?', team)
  }
  if (sp.get('provider')) add('r.provider = ?', sp.get('provider'))
  if (sp.get('model')) add('r.model_id ILIKE ?', `%${sp.get('model').replace(/[\\%_]/g, '\\$&')}%`)
  if (sp.get('status') === 'success') conditions.push('r.status_code < 400')
  if (sp.get('status') === 'error') conditions.push('r.status_code >= 400')

  const limit = Math.min(Math.max(parseInt(sp.get('limit') ?? '100', 10) || 100, 1), 1000)
  params.push(limit)

  const { rows } = await db.query(`
    SELECT r.id, r.created_at, r.provider, r.model_id,
           r.tokens_input, r.tokens_output, r.cost_usd,
           r.latency_ms, r.auth_ms, r.policy_ms, r.provider_ms,
           r.trace_id, r.status_code, r.is_stream,
           t.name  AS team_name,
           u.email AS user_email,
           a.name  AS agent_name
      FROM request_logs r
      LEFT JOIN teams  t ON t.id = r.team_id  AND t.org_id = r.org_id
      LEFT JOIN users  u ON u.id = r.user_id  AND u.org_id = r.org_id
      LEFT JOIN agents a ON a.id = r.agent_id AND a.org_id = r.org_id
     WHERE ${conditions.join(' AND ')}
     ORDER BY r.created_at DESC
     LIMIT $${params.length}
  `, params)
  return json(rows)
})
