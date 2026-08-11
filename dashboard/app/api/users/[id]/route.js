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

  if (body.teamId    !== undefined) { fields.push(`team_id = $${i++}`);   values.push(body.teamId || null) }
  if (body.role      !== undefined) { fields.push(`role = $${i++}`);      values.push(body.role) }
  if (body.isActive  !== undefined) { fields.push(`is_active = $${i++}`); values.push(body.isActive) }
  if (body.name      !== undefined) { fields.push(`name = $${i++}`);      values.push(body.name) }

  // Password reset
  if (body.newPassword) {
    const salt = crypto.randomBytes(16).toString('hex')
    const hash = await new Promise((res, rej) =>
      crypto.scrypt(body.newPassword, salt, 64, (err, key) =>
        err ? rej(err) : res(key.toString('hex'))
      )
    )
    fields.push(`password_hash = $${i++}`)
    values.push(`${salt}:${hash}`)
  }

  // Remove password access
  if (body.removePassword) {
    fields.push(`password_hash = $${i++}`)
    values.push(null)
  }

  if (!fields.length) return NextResponse.json({ error: 'Nada para actualizar' }, { status: 400 })

  values.push(id)
  const { rows } = await db.query(
    `UPDATE users SET ${fields.join(', ')} WHERE id = $${i} RETURNING *`,
    values
  )

  if (!rows[0]) return NextResponse.json({ error: 'Usuario no encontrado' }, { status: 404 })
  return NextResponse.json(rows[0])
}

export async function POST(req, { params }) {
  const { id }     = params
  const { action } = await req.json()
  const db         = getDb()

  if (action === 'rotate-key') {
    const rawKey    = `aig_sk_${crypto.randomBytes(24).toString('hex')}`
    const keyHash   = crypto.createHash('sha256').update(rawKey).digest('hex')
    const keyPrefix = rawKey.slice(0, 14) + '...'
    const { rows } = await db.query(
      `UPDATE users SET api_key_hash = $1, api_key_prefix = $2 WHERE id = $3 RETURNING id`,
      [keyHash, keyPrefix, id]
    )
    if (!rows[0]) return NextResponse.json({ error: 'Usuario no encontrado' }, { status: 404 })
    return NextResponse.json({ apiKey: rawKey })
  }

  if (action === 'remove-key') {
    await db.query(
      `UPDATE users SET api_key_hash = NULL, api_key_prefix = NULL WHERE id = $1`,
      [id]
    )
    return NextResponse.json({ ok: true })
  }

  return NextResponse.json({ error: 'Acción desconocida' }, { status: 400 })
}
