export const dynamic = 'force-dynamic'
import { NextResponse } from 'next/server'
import { query } from '../../../lib/db'

function parseDateRange(searchParams) {
  const from = searchParams.get('from')
  const to   = searchParams.get('to')
  const period = searchParams.get('period') // e.g. '2026-08'

  if (from && to) {
    return { from: new Date(from), to: new Date(to + 'T23:59:59Z') }
  }
  if (period) {
    const [year, month] = period.split('-').map(Number)
    return {
      from: new Date(year, month - 1, 1),
      to:   new Date(year, month, 0, 23, 59, 59),
    }
  }
  // Default: current month
  const now = new Date()
  return {
    from: new Date(now.getFullYear(), now.getMonth(), 1),
    to:   new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59),
  }
}

export async function GET(req) {
  const { searchParams } = new URL(req.url)
  const { from, to } = parseDateRange(searchParams)

  const [totals, daily, teams] = await Promise.all([
    // Totals
    query(`
      SELECT COUNT(*)                                         AS total_requests,
             COALESCE(SUM(tokens_input + tokens_output), 0)  AS total_tokens,
             COALESCE(SUM(cost_usd), 0)                      AS total_cost,
             COUNT(DISTINCT team_id)                         AS active_teams
      FROM request_logs
      WHERE created_at >= $1 AND created_at <= $2
    `, [from, to]),

    // Daily breakdown
    query(`
      SELECT TO_CHAR(DATE(created_at), 'DD/MM') AS day,
             COUNT(*)                           AS requests,
             COALESCE(SUM(cost_usd), 0)         AS cost
      FROM request_logs
      WHERE created_at >= $1 AND created_at <= $2
      GROUP BY DATE(created_at)
      ORDER BY DATE(created_at)
    `, [from, to]),

    // Teams
    query(`
      SELECT t.id AS team_id, t.name AS team_name, t.monthly_budget_usd AS team_budget,
             p.id AS policy_id, p.name AS policy_name, p.monthly_budget_usd,
             COUNT(r.id) AS total_requests,
             COALESCE(SUM(r.tokens_input + r.tokens_output),0) AS total_tokens,
             COALESCE(SUM(r.cost_usd), 0) AS total_cost,
             COUNT(DISTINCT r.user_id) AS active_users
      FROM teams t
      LEFT JOIN policies p     ON p.id = t.policy_id
      LEFT JOIN request_logs r ON r.team_id = t.id
                               AND r.created_at >= $1 AND r.created_at <= $2
      GROUP BY t.id, t.name, t.monthly_budget_usd, p.id, p.name, p.monthly_budget_usd
      ORDER BY total_cost DESC
    `, [from, to]),
  ])

  return NextResponse.json({
    totals: totals[0],
    daily:  daily.map(d => ({ day: d.day, requests: parseInt(d.requests), cost: parseFloat(d.cost) })),
    teams,
  })
}
