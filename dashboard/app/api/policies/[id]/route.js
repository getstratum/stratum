export const dynamic = 'force-dynamic'
import { NextResponse } from 'next/server'
import { getDb } from '../../../../lib/db'

export async function PATCH(req, { params }) {
  const { id } = params
  const { name, allowedModels, maxTokensPerRequest, monthlyTokenQuota, monthlyBudgetUsd } = await req.json()

  const db = getDb()
  const { rows } = await db.query(`
    UPDATE policies SET
      name                    = COALESCE($1, name),
      allowed_models          = COALESCE($2, allowed_models),
      max_tokens_per_request  = COALESCE($3, max_tokens_per_request),
      monthly_token_quota     = COALESCE($4, monthly_token_quota),
      monthly_budget_usd      = COALESCE($5, monthly_budget_usd)
    WHERE id = $6
    RETURNING *
  `, [name, allowedModels, maxTokensPerRequest, monthlyTokenQuota, monthlyBudgetUsd, id])

  if (!rows[0]) return NextResponse.json({ error: 'Política no encontrada' }, { status: 404 })
  return NextResponse.json(rows[0])
}

export async function DELETE(req, { params }) {
  const { id } = params
  const db = getDb()

  // Check no teams are using it
  const { rows: teams } = await db.query(
    `SELECT COUNT(*) FROM teams WHERE policy_id = $1`, [id]
  )
  if (parseInt(teams[0].count) > 0) {
    return NextResponse.json(
      { error: 'Esta política está asignada a uno o más equipos. Reasignalos primero.' },
      { status: 409 }
    )
  }

  await db.query(`DELETE FROM policies WHERE id = $1`, [id])
  return NextResponse.json({ ok: true })
}
