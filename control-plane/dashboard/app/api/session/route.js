export const dynamic = 'force-dynamic'
import { NextResponse } from 'next/server'
import { getDb } from '../../../lib/db.js'
import { route, publicRoute, readJson, json } from '../../../lib/route.js'
import { COOKIE, createSession, revokeSession, cookieOptions } from '../../../lib/session.js'
import { verifyPassword, needsRehash, hashPassword } from '../../../lib/password.js'
import { CONSOLE_ROLES, PERMISSIONS, scopeFor } from '../../../lib/authz.js'
import { audit, clientIp } from '../../../lib/audit.js'
import { mfaRequired, startChallenge, status as mfaStatus } from '../../../lib/mfa.js'

import { reserveAttempt, recordFailure, recordSuccess, INVALID } from '../../../lib/login.js'
import { passwordRefused } from '../../../lib/sso.js'

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
            u.password_hash, u.totp_enabled_at, o.status AS org_status
       FROM users u JOIN organizations o ON o.id = u.org_id
      WHERE lower(u.email) = $1
      LIMIT 1`,
    [email])
  const u = rows[0]

  const reserved = u ? await reserveAttempt(db, u.id) : null

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
    await recordFailure(db, u.id, reserved)
    return refuse('bad_password')
  }
  if (!u.is_active) return refuse('inactive')
  if (u.org_status !== 'active') return refuse('org_suspended')
  if (!CONSOLE_ROLES.includes(u.role)) return refuse('role_without_console')
  // The organization signs in with its identity provider (lib/sso.js): only
  // after a right password, so this says nothing about who has an account.
  if (await passwordRefused(db, { email: u.email, orgId: u.org_id, role: u.role })) {
    await audit(db, { req, orgId: u.org_id, actor: u.email, action: 'session.login', result: 'failed', details: { reason: 'sso_required' } })
    return json({ error: 'sso_required', message: 'Tu organización ingresa con su proveedor de identidad: usá «Entrar con SSO».' }, 401)
  }

  // Second factor set up: the password only earns a challenge. The attempt
  // stays counted until the code is right (POST /api/session/mfa).
  if (u.totp_enabled_at) {
    if (needsRehash(u.password_hash)) {
      await db.query('UPDATE users SET password_hash = $2 WHERE id = $1', [u.id, await hashPassword(password)])
    }
    const challenge = await startChallenge(db, u.id)
    await audit(db, { req, orgId: u.org_id, actor: u.email, action: 'session.password_ok', details: { next: 'second_factor' } })
    return json({ mfa_required: true, challenge })
  }

  // Succeeds only if no concurrent failure locked the account meanwhile.
  if (!await recordSuccess(db, u.id, needsRehash(u.password_hash) ? await hashPassword(password) : null)) {
    return refuse('locked')
  }

  // An Owner or Admin without a second factor gets in only to set it up.
  const enrollmentOnly = mfaRequired(u.role)
  const token = await createSession(db, {
    userId: u.id, orgId: u.org_id, ip: clientIp(req), userAgent: req.headers.get('user-agent'), enrollmentOnly,
  })
  await audit(db, {
    req, session: { orgId: u.org_id, userId: u.id, email: u.email, role: u.role }, action: 'session.login',
    details: enrollmentOnly ? { mfa: 'enrollment_required' } : undefined,
  })

  const res = NextResponse.json({ ok: true, role: u.role, mfa_enrollment_required: enrollmentOnly })
  res.cookies.set(COOKIE, token, cookieOptions())
  return res
})

// GET /api/session → who is signed in, and what they may do
export const GET = route('org.read', async (req, { session, db }) => {
  const permissions = {}
  if (!session.enrollmentOnly) {
    for (const p of Object.keys(PERMISSIONS)) {
      const scope = scopeFor(session.role, p)
      if (scope) permissions[p] = scope
    }
  }
  const mfa = await mfaStatus(db, session.userId)
  return json({
    user: { id: session.userId, email: session.email, name: session.name, role: session.role, teamId: session.teamId },
    org:  { id: session.orgId, name: session.orgName },
    permissions,
    mfa: { enabled: mfa.enabled, required: mfaRequired(session.role), enrollmentRequired: !!session.enrollmentOnly },
  })
}, { duringEnrollment: true })

// DELETE /api/session → sign out
export const DELETE = publicRoute(async (req) => {
  const token = req.cookies.get(COOKIE)?.value
  if (token) await revokeSession(getDb(), token)
  const res = NextResponse.json({ ok: true })
  res.cookies.set(COOKIE, '', { ...cookieOptions(), maxAge: 0 })
  return res
})
