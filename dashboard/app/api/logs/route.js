export const dynamic = 'force-dynamic'
import { NextResponse } from 'next/server'
import { getDb } from '../../../lib/db'

export async function GET(req) {
  const { searchParams } = new URL(req.url)

  const teamId   = searchParams.get('team')
  const provider = searchParams.get('provider')
  const model    = searchParams.get('model')
  const status   = searchParams.get('status')   // 'success' | 'error' | ''
  const from     = searchParams.get('from')
  const to       = searchParams.get('to')
  const period   = searchParams.get('period')
  const limit    = Math.min(parseInt(searchParams.get('limit') ?? '100'), 1000)

  const conditions = []
  const params = []
  let i = 1

  // Date range
  if (from && to) {
    conditions.push(`r.created_at >= $${i++} AND r.created_at <= $${i++}`)
    params.push(new Date(from), new Date(to + 'T23:59:59Z'))
  } else if (period) {
    const [y, m] = period.split('-').map(Number)
    conditions.push(`r.created_at >= $${i++} AND r.created_at <= $${i++}`)
    params.push(new Date(y, m - 1, 1), new Date(y, m, 0, 23, 59, 59))
  }

  if (teamId)                { conditions.push(`r.team_id = $${i++}`);              params.push(teamId) }
  if (provider)              { conditions.push(`r.provider = $${i++}`);             params.push(provider) }
  if (model)                 { conditions.push(`r.model_id ILIKE $${i++}`);         params.push(`%${model}%`) }
  if (status === 'success')  { conditions.push('r.status_code < 400') }
  if (status === 'error')    { conditions.push('r.status_code >= 400') }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
  params.push(limit)

  const db = getDb()
  const { rows } = await db.query(`
    SELECT r.id, r.created_at, r.provider, r.model_id,
           r.tokens_input, r.tokens_output, r.cost_usd,
           r.latency_ms, r.auth_ms, r.policy_ms, r.provider_ms,
           r.trace_id, r.status_code, r.is_stream,
           t.name  AS team_name,
           u.email AS user_email,
           a.name  AS agent_name
    FROM request_logs r
    LEFT JOIN teams  t ON t.id = r.team_id
    LEFT JOIN users  u ON u.id = r.user_id
    LEFT JOIN agents a ON a.id = r.agent_id
    ${where}
    ORDER BY r.created_at DESC
    LIMIT $${i}
  `, params)

  return NextResponse.json(rows)
}
