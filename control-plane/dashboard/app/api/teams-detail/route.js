export const dynamic = 'force-dynamic'
import { NextResponse } from 'next/server'
import { query } from '../../../lib/db'

const DEMO_ORG = '00000000-0000-0000-0000-000000000001'

export async function GET() {
  const teams = await query(`
    SELECT
      t.id, t.name, t.department, t.monthly_budget_usd AS team_budget,
      p.name AS policy_name, p.allowed_models,
      p.monthly_token_quota, p.monthly_budget_usd AS policy_budget,
      COUNT(DISTINCT u.id)                              AS total_users,
      COUNT(r.id)                                       AS requests_month,
      COALESCE(SUM(r.tokens_input + r.tokens_output),0) AS tokens_month,
      COALESCE(SUM(r.cost_usd),0)                       AS cost_month
    FROM teams t
    LEFT JOIN policies p     ON p.id = t.policy_id
    LEFT JOIN users u        ON u.team_id = t.id AND u.is_active = true
    LEFT JOIN request_logs r ON r.team_id = t.id
                             AND r.created_at >= date_trunc('month', NOW())
    WHERE t.org_id = $1
    GROUP BY t.id, t.name, t.department, t.monthly_budget_usd,
             p.name, p.allowed_models, p.monthly_token_quota, p.monthly_budget_usd
    ORDER BY cost_month DESC
  `, [DEMO_ORG])

  return NextResponse.json(teams)
}
