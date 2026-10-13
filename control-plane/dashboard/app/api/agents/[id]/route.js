export const dynamic = 'force-dynamic'
import { NextResponse } from 'next/server'
import crypto from 'crypto'
import { getDb } from '../../../../lib/db'

export async function PATCH(req, { params }) {
  const { id } = params
  const body   = await req.json()
  const db     = getDb()

  const fields = []
  const values = []
  let i = 1

  if (body.name            !== undefined) { fields.push(`name = $${i++}`);             values.push(body.name) }
  if (body.description     !== undefined) { fields.push(`description = $${i++}`);       values.push(body.description) }
  if (body.teamId          !== undefined) { fields.push(`team_id = $${i++}`);           values.push(body.teamId || null) }
  if (body.isActive        !== undefined) { fields.push(`is_active = $${i++}`);         values.push(body.isActive) }
  if (body.defaultModel    !== undefined) { fields.push(`default_model = $${i++}`);     values.push(body.defaultModel || null) }
  if (body.defaultProvider !== undefined) { fields.push(`default_provider = $${i++}`); values.push(body.defaultProvider || null) }

  if (!fields.length) return NextResponse.json({ error: 'Nothing to update' }, { status: 400 })

  values.push(id)
  const { rows } = await db.query(
    `UPDATE agents SET ${fields.join(', ')} WHERE id = $${i} RETURNING *`,
    values
  )
  if (!rows[0]) return NextResponse.json({ error: 'Agent not found' }, { status: 404 })
  return NextResponse.json(rows[0])
}

export async function POST(req, { params }) {
  const { id }     = params
  const { action } = await req.json()
  const db         = getDb()

  if (action !== 'rotate-key') {
    return NextResponse.json({ error: 'Unknown action' }, { status: 400 })
  }

  const rawKey    = `aig_agt_${crypto.randomBytes(24).toString('hex')}`
  const keyHash   = crypto.createHash('sha256').update(rawKey).digest('hex')
  const keyPrefix = rawKey.slice(0, 16) + '...'

  const { rows } = await db.query(
    `UPDATE agents SET api_key_hash = $1, api_key_prefix = $2 WHERE id = $3 RETURNING id`,
    [keyHash, keyPrefix, id]
  )
  if (!rows[0]) return NextResponse.json({ error: 'Agent not found' }, { status: 404 })
  return NextResponse.json({ apiKey: rawKey })
}
