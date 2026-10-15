export const dynamic = 'force-dynamic'
import { NextResponse } from 'next/server'
import { getDb } from '../../../lib/db.js'
import { route, publicRoute, readJson, json } from '../../../lib/route.js'
import { COOKIE, createSession, revokeSession, cookieOptions } from '../../../lib/session.js'
import { verifyPassword, needsRehash, hashPassword } from '../../../lib/password.js'
import { CONSOLE_ROLES, PERMISSIONS, scopeFor } from '../../../lib/authz.js'
import { audit, clientIp } from '../../../lib/audit.js'

// After this many failed attempts in a row the account is locked for
// LOCK_MINUTES. The counter resets on a successful sign-in.
const MAX_FAILED = 10
const LOCK_MINUTES = 15

const INVALID = 'Email o contraseña incorrectos, o la cuenta está bloqueada por unos minutos.'

// POST /api/session  { email, password }  → sign in
//
// Every refusal gets the same 401, so the response never tells whether an
// email has an account, whether it is locked or deactivated, or whether a
// password was right for an account that cannot sign in. The reason is in
// the audit log.
export const POST = publicRoute(async (req) => {
  const db = getDb()
  const body = await readJson(req)
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : ''
  const password = body.password

  const { rows } = await db.query(
    `SELECT u.id, u.org_id, u.email, u.role, COALESCE(u.is_active, true) AS is_active,
            u.password_hash, o.status AS org_status
       FROM users u JOIN organizations o ON o.id = u.org_id
      WHERE lower(u.email) = $1
      LIMIT 1`,
    [email])
  const u = rows[0]

  // Reserve the attempt before checking the password, atomically: at most
  // MAX_FAILED attempts can be in flight or counted until a success resets
  // the counter, however many requests arrive at once. No row: locked.
  let reserved = null
  if (u) {
    const r = await db.query(
      `UPDATE users SET failed_logins = failed_logins + 1
        WHERE id = $1 AND (locked_until IS NULL OR locked_until <= now()) AND failed_logins < $2
        RETURNING failed_logins`,
      [u.id, MAX_FAILED])
    reserved = r.rows[0] ?? null
    if (!reserved) {
      // A counter left at the limit without a lock (a request that died
      // after reserving) becomes a lock that expires, never a permanent one.
      await db.query(
        `UPDATE users SET failed_logins = 0, locked_until = now() + make_interval(mins => $3)
          WHERE id = $1 AND (locked_until IS NULL OR locked_until <= now()) AND failed_logins >= $2`,
        [u.id, MAX_FAILED, LOCK_MINUTES])
    }
  }

  // Always run the password check, so timing does not tell which accounts exist.
  const ok = await verifyPassword(password, u?.password_hash)

  const refuse = async (reason) => {
    await audit(db, {
      req, orgId: u?.org_id ?? null, actor: u?.email ?? (email.slice(0, 200) || null),
      action: 'session.login', result: 'failed', details: { reason },
    })
    return json({ error: 'invalid_credentials', message: INVALID }, 401)
  }

  if (!u) return refuse('unknown_email')
  if (!reserved) return refuse('locked')
  if (!ok) {
    if (reserved.failed_logins >= MAX_FAILED) {
      await db.query(
        `UPDATE users SET failed_logins = 0, locked_until = now() + make_interval(mins => $2) WHERE id = $1`,
        [u.id, LOCK_MINUTES])
    }
    return refuse('bad_password')
  }
  if (!u.is_active) return refuse('inactive')
  if (u.org_status !== 'active') return refuse('org_suspended')
  if (!CONSOLE_ROLES.includes(u.role)) return refuse('role_without_console')

  // Succeeds only if no concurrent failure locked the account meanwhile.
  const done = await db.query(
    `UPDATE users SET failed_logins = 0, locked_until = NULL, last_login_at = now(),
                      password_hash = COALESCE($2, password_hash)
      WHERE id = $1 AND (locked_until IS NULL OR locked_until <= now())
      RETURNING id`,
    [u.id, needsRehash(u.password_hash) ? await hashPassword(password) : null])
  if (!done.rows[0]) return refuse('locked')

  const token = await createSession(db, {
    userId: u.id, orgId: u.org_id, ip: clientIp(req), userAgent: req.headers.get('user-agent'),
  })
  await audit(db, { req, session: { orgId: u.org_id, userId: u.id, email: u.email, role: u.role }, action: 'session.login' })

  const res = NextResponse.json({ ok: true, role: u.role })
  res.cookies.set(COOKIE, token, cookieOptions())
  return res
})

// GET /api/session → who is signed in, and what they may do
export const GET = route('org.read', async (req, { session }) => {
  const permissions = {}
  for (const p of Object.keys(PERMISSIONS)) {
    const scope = scopeFor(session.role, p)
    if (scope) permissions[p] = scope
  }
  return json({
    user: { id: session.userId, email: session.email, name: session.name, role: session.role, teamId: session.teamId },
    org:  { id: session.orgId, name: session.orgName },
    permissions,
  })
})

// DELETE /api/session → sign out
export const DELETE = publicRoute(async (req) => {
  const token = req.cookies.get(COOKIE)?.value
  if (token) await revokeSession(getDb(), token)
  const res = NextResponse.json({ ok: true })
  res.cookies.set(COOKIE, '', { ...cookieOptions(), maxAge: 0 })
  return res
})
