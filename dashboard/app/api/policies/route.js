export const dynamic = 'force-dynamic'
import { NextResponse } from 'next/server'
import { query, getDb } from '../../../lib/db'

const DEMO_ORG = '00000000-0000-0000-0000-000000000001'

export async function GET() {
  const policies = await query(`
    SELECT p.*,
           COUNT(DISTINCT t.id) AS teams_using
    FROM policies p
    LEFT JOIN teams t ON t.policy_id = p.id
    WHERE p.org_id = $1
    GROUP BY p.id
    ORDER BY p.created_at
  `, [DEMO_ORG])

  return NextResponse.json(policies)
}

export async function POST(req) {
  const body = await req.json()
  const { name, allowedModels, maxTokensPerRequest, monthlyTokenQuota, monthlyBudgetUsd } = body

  if (!name) return NextResponse.json({ error: 'Nombre requerido' }, { status: 400 })

  const db = getDb()
  const { rows } = await db.query(`
    INSERT INTO policies
      (org_id, name, allowed_models, max_tokens_per_request, monthly_token_quota, monthly_budget_usd)
    VALUES ($1, $2, $3, $4, $5, $6)
    RETURNING *
  `, [
    DEMO_ORG,
    name,
    allowedModels ?? [],
    maxTokensPerRequest ?? 4096,
    monthlyTokenQuota   ?? 1000000,
    monthlyBudgetUsd    ?? 100,
  ])

  return NextResponse.json(rows[0], { status: 201 })
}
