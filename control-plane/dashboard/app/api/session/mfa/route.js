export const dynamic = 'force-dynamic'
import { NextResponse } from 'next/server'
import { getDb } from '../../../../lib/db.js'
import { route, publicRoute, readJson, json, forbidden, badRequest, HttpError } from '../../../../lib/route.js'
import { COOKIE, createSession, cookieOptions, revokeUserSessions } from '../../../../lib/session.js'
import { CONSOLE_ROLES } from '../../../../lib/authz.js'
import { audit, clientIp } from '../../../../lib/audit.js'
import { verifyPassword } from '../../../../lib/password.js'
import { reserveAttempt, recordFailure, recordSuccess, guardedCheck, LOCKED_IN_SESSION } from '../../../../lib/login.js'
import { useChallenge, endChallenge, checkSecondFactor, mfaRequired, disable, status } from '../../../../lib/mfa.js'

const INVALID_CODE = 'Código incorrecto o vencido. Si pasaron más de 5 minutos, volvé a ingresar la contraseña.'

// POST /api/session/mfa  { challenge, code }  → second step of the sign-in
//
// code: 6 digits from the authenticator, or a recovery code. Each try counts
// against the challenge (5) and the account's lockout, like a password.
export const POST = publicRoute(async (req) => {
  const db = getDb()
  const body = await readJson(req)
  const userId = await useChallenge(db, body.challenge)
  const refuse = async (reason, u) => {
    await audit(db, {
      req, orgId: u?.org_id ?? null, actor: u?.email ?? null,
      action: 'session.login', result: 'failed', details: { reason, step: 'second_factor' },
    })
    return json({ error: 'invalid_code', message: INVALID_CODE }, 401)
  }
  if (!userId) return refuse('unknown_or_expired_challenge')

  const { rows: [u] } = await db.query(
    `SELECT u.id, u.org_id, u.email, u.role, COALESCE(u.is_active, true) AS is_active, o.status AS org_status
       FROM users u JOIN organizations o ON o.id = u.org_id WHERE u.id = $1`, [userId])
  if (!u) return refuse('unknown_user')
  const reserved = await reserveAttempt(db, u.id)
  if (!reserved) return refuse('locked', u)

  const method = await checkSecondFactor(db, u.id, body.code)
  if (!method) {
    await recordFailure(db, u.id, reserved)
    return refuse('bad_code', u)
  }
  // The account may have changed since the password step.
  if (!u.is_active) return refuse('inactive', u)
  if (u.org_status !== 'active') return refuse('org_suspended', u)
  if (!CONSOLE_ROLES.includes(u.role)) return refuse('role_without_console', u)
  if (!await recordSuccess(db, u.id)) return refuse('locked', u)
  await endChallenge(db, body.challenge)

  const token = await createSession(db, {
    userId: u.id, orgId: u.org_id, ip: clientIp(req), userAgent: req.headers.get('user-agent'),
  })
  await audit(db, {
    req, session: { orgId: u.org_id, userId: u.id, email: u.email, role: u.role },
    action: 'session.login', details: { mfa: method },
  })
  const left = method === 'recovery_code' ? (await status(db, u.id)).recoveryCodesLeft : undefined
  const res = NextResponse.json({ ok: true, role: u.role, recovery_codes_left: left })
  res.cookies.set(COOKIE, token, cookieOptions())
  return res
})

// GET /api/session/mfa → whether the signed-in person uses a second factor
export const GET = route('org.read', async (req, { session, db }) => {
  return json({ ...(await status(db, session.userId)), required: mfaRequired(session.role) })
}, { duringEnrollment: true })

// DELETE /api/session/mfa  { password, code } → turn it off (roles that do not require it)
export const DELETE = route('org.read', async (req, { session, db }) => {
  if (mfaRequired(session.role)) throw forbidden('La verificación en dos pasos es obligatoria para tu rol.')
  const body = await readJson(req)
  const { rows: [u] } = await db.query('SELECT password_hash, totp_enabled_at FROM users WHERE id = $1', [session.userId])
  if (!u?.totp_enabled_at) throw badRequest('No tenés la verificación en dos pasos activada.')
  const passed = await guardedCheck(db, session.userId, async () =>
    (await verifyPassword(body.password, u.password_hash)) && !!(await checkSecondFactor(db, session.userId, body.code)))
  if (passed !== true) {
    await audit(db, { req, session, action: 'mfa.disable', result: 'failed', targetType: 'user', targetId: session.userId })
    if (passed === 'locked') throw new HttpError(429, 'locked', LOCKED_IN_SESSION)
    throw forbidden('La contraseña o el código no son correctos.')
  }
  await disable(db, session.userId)
  await revokeUserSessions(db, session.userId, session.tokenHash)
  await audit(db, { req, session, action: 'mfa.disable', targetType: 'user', targetId: session.userId })
  return json({ ok: true })
})
