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

  if (body.thresholdPct  !== undefined) { fields.push(`threshold_pct = $${i++}`); values.push(body.thresholdPct) }
  if (body.destination   !== undefined) { fields.push(`destination = $${i++}`);   values.push(body.destination) }
  if (body.isActive      !== undefined) { fields.push(`is_active = $${i++}`);     values.push(body.isActive) }
  // Allow resetting last_fired_at to re-enable a fired alert
  if (body.resetFired)                  { fields.push(`last_fired_at = $${i++}`); values.push(null) }

  if (!fields.length) return NextResponse.json({ error: 'Nothing to update' }, { status: 400 })

  values.push(id)
  const { rows } = await db.query(
    `UPDATE alerts SET ${fields.join(', ')} WHERE id = $${i} RETURNING *`,
    values
  )

  if (!rows[0]) return NextResponse.json({ error: 'Alert not found' }, { status: 404 })
  return NextResponse.json(rows[0])
}

export async function DELETE(req, { params }) {
  const db = getDb()
  await db.query('DELETE FROM alerts WHERE id = $1', [params.id])
  return NextResponse.json({ ok: true })
}
