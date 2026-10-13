export const dynamic = 'force-dynamic'
import { NextResponse } from 'next/server'
import { getDb } from '../../../../lib/db'

export async function PATCH(req, { params }) {
  const { id } = params
  const body   = await req.json()
  const db     = getDb()

  const fields = []
  const values = []
  let i = 1

  if (body.name              !== undefined) { fields.push(`name = $${i++}`);               values.push(body.name) }
  if (body.policyId          !== undefined) { fields.push(`policy_id = $${i++}`);          values.push(body.policyId || null) }
  if (body.monthlyBudgetUsd  !== undefined) { fields.push(`monthly_budget_usd = $${i++}`); values.push(body.monthlyBudgetUsd) }

  if (!fields.length) return NextResponse.json({ error: 'Nothing to update' }, { status: 400 })

  values.push(id)
  const { rows } = await db.query(
    `UPDATE teams SET ${fields.join(', ')} WHERE id = $${i} RETURNING *`,
    values
  )

  if (!rows[0]) return NextResponse.json({ error: 'Team not found' }, { status: 404 })
  return NextResponse.json(rows[0])
}
