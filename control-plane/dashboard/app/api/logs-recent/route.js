export const dynamic = 'force-dynamic'
import { NextResponse } from 'next/server'
import { query } from '../../../lib/db'

export async function GET() {
  const logs = await query(`
    SELECT r.id, r.created_at, r.provider, r.model_id,
           r.tokens_input, r.tokens_output, r.cost_usd,
           r.latency_ms, r.auth_ms, r.policy_ms, r.provider_ms,
           r.trace_id, r.status_code,
           t.name  AS team_name,
           u.email AS user_email,
           a.name  AS agent_name
    FROM request_logs r
    LEFT JOIN teams  t ON t.id = r.team_id
    LEFT JOIN users  u ON u.id = r.user_id
    LEFT JOIN agents a ON a.id = r.agent_id
    ORDER BY r.created_at DESC
    LIMIT 10
  `)
  return NextResponse.json(logs)
}
