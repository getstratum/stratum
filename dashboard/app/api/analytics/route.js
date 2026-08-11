export const dynamic = 'force-dynamic'
import { NextResponse } from 'next/server'
import { query } from '../../../lib/db'

function parseDateRange(searchParams) {
  const from = searchParams.get('from')
  const to   = searchParams.get('to')
  const period = searchParams.get('period')

  if (from && to) return { from: new Date(from), to: new Date(to + 'T23:59:59Z') }
  if (period) {
    const [year, month] = period.split('-').map(Number)
    return { from: new Date(year, month - 1, 1), to: new Date(year, month, 0, 23, 59, 59) }
  }
  const now = new Date()
  return {
    from: new Date(now.getFullYear(), now.getMonth(), 1),
    to:   new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59),
  }
}

export async function GET(req) {
  const { searchParams } = new URL(req.url)
  const { from, to } = parseDateRange(searchParams)

  const [byProvider, byModel, byTeamProvider] = await Promise.all([

    // By provider
    query(`
      SELECT provider,
             COUNT(*)                                        AS requests,
             COALESCE(SUM(tokens_input + tokens_output), 0) AS tokens,
             COALESCE(SUM(cost_usd), 0)                     AS cost,
             COALESCE(AVG(latency_ms), 0)                   AS avg_latency,
             COUNT(CASE WHEN status_code >= 400 THEN 1 END) AS errors
      FROM request_logs
      WHERE created_at >= $1 AND created_at <= $2
      GROUP BY provider
      ORDER BY cost DESC
    `, [from, to]),

    // By model (top 10)
    query(`
      SELECT provider, model_id,
             COUNT(*)                                        AS requests,
             COALESCE(SUM(tokens_input), 0)                 AS tokens_input,
             COALESCE(SUM(tokens_output), 0)                AS tokens_output,
             COALESCE(SUM(cost_usd), 0)                     AS cost,
             COALESCE(AVG(latency_ms), 0)                   AS avg_latency
      FROM request_logs
      WHERE created_at >= $1 AND created_at <= $2
      GROUP BY provider, model_id
      ORDER BY cost DESC
      LIMIT 10
    `, [from, to]),

    // Cost by team × provider (for stacked chart)
    query(`
      SELECT t.name AS team, r.provider,
             COALESCE(SUM(r.cost_usd), 0) AS cost,
             COUNT(*) AS requests
      FROM request_logs r
      JOIN teams t ON t.id = r.team_id
      WHERE r.created_at >= $1 AND r.created_at <= $2
      GROUP BY t.name, r.provider
      ORDER BY t.name, cost DESC
    `, [from, to]),
  ])

  return NextResponse.json({
    byProvider: byProvider.map(r => ({
      provider:   r.provider,
      requests:   parseInt(r.requests),
      tokens:     parseInt(r.tokens),
      cost:       parseFloat(r.cost),
      avgLatency: Math.round(parseFloat(r.avg_latency)),
      errors:     parseInt(r.errors),
    })),
    byModel: byModel.map(r => ({
      provider:     r.provider,
      model:        r.model_id,
      requests:     parseInt(r.requests),
      tokensInput:  parseInt(r.tokens_input),
      tokensOutput: parseInt(r.tokens_output),
      cost:         parseFloat(r.cost),
      avgLatency:   Math.round(parseFloat(r.avg_latency)),
    })),
    byTeamProvider: byTeamProvider.map(r => ({
      team:     r.team,
      provider: r.provider,
      cost:     parseFloat(r.cost),
      requests: parseInt(r.requests),
    })),
  })
}
