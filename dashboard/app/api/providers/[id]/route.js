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

  if (body.isActive    !== undefined) { fields.push(`is_active = $${i++}`);    values.push(body.isActive) }
  if (body.displayName !== undefined) { fields.push(`display_name = $${i++}`); values.push(body.displayName) }
  if (body.baseUrl     !== undefined) { fields.push(`base_url = $${i++}`);     values.push(body.baseUrl) }
  if (body.apiKeyEnv   !== undefined) { fields.push(`api_key_env = $${i++}`);  values.push(body.apiKeyEnv) }
  if (body.notes       !== undefined) { fields.push(`notes = $${i++}`);        values.push(body.notes) }

  if (!fields.length) return NextResponse.json({ error: 'Nothing to update' }, { status: 400 })

  values.push(id)
  const { rows } = await db.query(
    `UPDATE providers SET ${fields.join(', ')} WHERE id = $${i} RETURNING *`,
    values
  )

  if (!rows[0]) return NextResponse.json({ error: 'Provider not found' }, { status: 404 })
  return NextResponse.json(rows[0])
}

export async function DELETE(req, { params }) {
  const db = getDb()
  // Don't allow deleting built-in providers
  const { rows } = await db.query(
    `SELECT slug FROM providers WHERE id = $1`, [params.id]
  )
  if (['openai', 'anthropic'].includes(rows[0]?.slug)) {
    return NextResponse.json({ error: 'Cannot delete built-in providers. Disable them instead.' }, { status: 400 })
  }
  await db.query('DELETE FROM providers WHERE id = $1', [params.id])
  return NextResponse.json({ ok: true })
}
