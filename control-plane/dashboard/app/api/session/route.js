export const dynamic = 'force-dynamic'
import { NextResponse }        from 'next/server'
import { SignJWT }             from 'jose'
import { createHash }          from 'crypto'
import { query }               from '@/lib/db'
import { getSessionSecret } from '@/lib/secret'

// Server-side gateway URL — used only for the Playground's Admin token-exchange flow
const GATEWAY_INTERNAL = process.env.GATEWAY_INTERNAL_URL
                      ?? process.env.NEXT_PUBLIC_GATEWAY_URL
                      ?? 'http://gateway:20128'

function getSecret() {
  return getSessionSecret()
}

function setCookie(response, session) {
  response.cookies.set('stratum_session', session, {
    httpOnly: true,
    secure:   process.env.SECURE_COOKIES === 'true',
    sameSite: 'lax',
    maxAge:   60 * 60 * 24,
    path:     '/',
  })
}

async function buildSession(user, team) {
  return new SignJWT({
    email:    user.email,
    name:     user.name,
    role:     user.role,
    teamName: team?.name ?? '',
    teamId:   team?.id   ?? '',
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime('24h')
    .sign(getSecret())
}

// POST /api/session
// Accepts either:
//   { email, password }  → email + API key login (password = raw API key)
//   { token }            → token exchange: Playground API key → Dashboard session
export async function POST(req) {
  const body = await req.json()

  // ── Token exchange (Admin button from Playground) ─────────────────────────
  // The Playground passes the raw API key as `token`; we resolve it to a user
  // directly from PostgreSQL (no gateway call needed).
  if (body.token && !body.email) {
    const hash = createHash('sha256').update(body.token).digest('hex')
    const rows = await query(
      `SELECT u.id, u.email, u.name, u.role,
              t.id AS team_id, t.name AS team_name
         FROM users u
         JOIN teams t ON t.id = u.team_id
        WHERE u.api_key_hash = $1
          AND (u.key_revoked IS NULL OR u.key_revoked = false)
        LIMIT 1`,
      [hash]
    ).catch(() => [])

    if (!rows[0]) {
      return NextResponse.json({ error: 'Invalid or expired token' }, { status: 401 })
    }

    const u    = rows[0]
    const user = { email: u.email, name: u.name, role: u.role }
    const team = { id: u.team_id, name: u.team_name }
    const session  = await buildSession(user, team)
    const response = NextResponse.json({ ok: true, teamName: team.name, role: user.role })
    setCookie(response, session)
    return response
  }

  // ── Email + API-key login ─────────────────────────────────────────────────
  const { email, password } = body
  if (!email || !password) {
    return NextResponse.json({ error: 'Email and API key are required' }, { status: 400 })
  }

  const hash = createHash('sha256').update(password).digest('hex')
  const rows = await query(
    `SELECT u.id, u.email, u.name, u.role,
            t.id AS team_id, t.name AS team_name
       FROM users u
       JOIN teams t ON t.id = u.team_id
      WHERE u.email = $1
        AND u.api_key_hash = $2
        AND (u.key_revoked IS NULL OR u.key_revoked = false)
      LIMIT 1`,
    [email, hash]
  ).catch(err => {
    console.error('[session] db error:', err.message)
    return []
  })

  if (!rows[0]) {
    return NextResponse.json({ error: 'Invalid credentials' }, { status: 401 })
  }

  const u    = rows[0]
  const user = { email: u.email, name: u.name, role: u.role }
  const team = { id: u.team_id, name: u.team_name }
  const session  = await buildSession(user, team)
  const response = NextResponse.json({ ok: true, teamName: team.name, role: user.role })
  setCookie(response, session)
  return response
}

// DELETE /api/session — logout
export async function DELETE() {
  const response = NextResponse.json({ ok: true })
  response.cookies.delete('stratum_session')
  return response
}
