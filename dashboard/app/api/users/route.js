export const dynamic = 'force-dynamic'
import { NextResponse } from 'next/server'
import crypto from 'crypto'
import { query, getDb } from '../../../lib/db'

const DEMO_ORG = '00000000-0000-0000-0000-000000000001'

export async function GET() {
  const users = await query(`
    SELECT u.id, u.email, u.name, u.role, u.is_active,
           u.api_key_prefix, u.created_at,
           (u.password_hash IS NOT NULL) AS has_password,
           (u.api_key_hash  IS NOT NULL) AS has_api_key,
           t.id   AS team_id,
           t.name AS team_name
    FROM users u
    LEFT JOIN teams t ON t.id = u.team_id
    WHERE u.org_id = $1
    ORDER BY u.created_at DESC
  `, [DEMO_ORG])

  return NextResponse.json(users)
}

export async function POST(req) {
  const { email, name, teamId, role = 'user', password, giveApiKey = false } = await req.json()

  if (!email) return NextResponse.json({ error: 'Email requerido' }, { status: 400 })
  if (!password && !giveApiKey) {
    return NextResponse.json({ error: 'El usuario necesita contraseña o API key (o ambas)' }, { status: 400 })
  }

  const db = getDb()

  let rawKey    = null
  let keyHash   = null
  let keyPrefix = null
  if (giveApiKey) {
    rawKey    = `aig_sk_${crypto.randomBytes(24).toString('hex')}`
    keyHash   = crypto.createHash('sha256').update(rawKey).digest('hex')
    keyPrefix = rawKey.slice(0, 14) + '...'
  }

  let passwordHash = null
  if (password) {
    const salt = crypto.randomBytes(16).toString('hex')
    const hash = await new Promise((res, rej) =>
      crypto.scrypt(password, salt, 64, (err, key) =>
        err ? rej(err) : res(key.toString('hex'))
      )
    )
    passwordHash = `${salt}:${hash}`
  }

  const { rows } = await db.query(`
    INSERT INTO users
      (org_id, team_id, email, name, role, api_key_hash, api_key_prefix, password_hash)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
    RETURNING id, email, name, role, is_active, api_key_prefix, created_at
  `, [
    DEMO_ORG, teamId || null,
    email, name || email.split('@')[0], role,
    keyHash, keyPrefix, passwordHash,
  ])

  return NextResponse.json({ user: rows[0], apiKey: rawKey }, { status: 201 })
}
