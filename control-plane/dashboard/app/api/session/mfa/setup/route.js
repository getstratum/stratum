export const dynamic = 'force-dynamic'
import { route, readJson, json, forbidden, conflict, badRequest, HttpError } from '../../../../../lib/route.js'
import { revokeUserSessions } from '../../../../../lib/session.js'
import { audit } from '../../../../../lib/audit.js'
import { verifyPassword } from '../../../../../lib/password.js'
import { guardedCheck, LOCKED_IN_SESSION } from '../../../../../lib/login.js'
import { beginSetup, completeSetup } from '../../../../../lib/mfa.js'
import { qrSvg } from '../../../../../lib/qr.js'

// Setting up the authenticator, open to a session that must do it first
// (an Owner or Admin who signed in without a second factor).

// POST /api/session/mfa/setup  { password } → a new secret, as text and QR code
//
// The password again: a session left open must not be enough to tie the
// account to someone else's phone.
export const POST = route('org.read', async (req, { session, db }) => {
  const body = await readJson(req)
  const { rows: [u] } = await db.query('SELECT password_hash, totp_enabled_at FROM users WHERE id = $1', [session.userId])
  if (u?.totp_enabled_at) throw conflict('Ya tenés la verificación en dos pasos activada.')
  const passed = await guardedCheck(db, session.userId, () => verifyPassword(body.password, u?.password_hash))
  if (passed !== true) {
    await audit(db, { req, session, action: 'mfa.setup', result: 'failed', targetType: 'user', targetId: session.userId })
    throw passed === 'locked' ? new HttpError(429, 'locked', LOCKED_IN_SESSION) : forbidden('La contraseña no es correcta.')
  }
  let setup
  try {
    setup = await beginSetup(db, session)
  } catch (err) {
    if (/STRATUM_ENCRYPTION_KEY/.test(err.message)) {
      throw new HttpError(500, 'encryption_failed', 'No se pudo guardar el secreto cifrado: revisá STRATUM_ENCRYPTION_KEY.')
    }
    throw err
  }
  const { secret, uri } = setup
  return json({ secret, uri, qr_svg: qrSvg(uri) })
}, { duringEnrollment: true })

// PUT /api/session/mfa/setup  { code } → confirm with a first code; returns
// the recovery codes, shown this once
export const PUT = route('org.read', async (req, { session, db }) => {
  const body = await readJson(req)
  if (typeof body.code !== 'string' || !/^\d{6}$/.test(body.code.replace(/\s/g, ''))) {
    throw badRequest('Ingresá los 6 dígitos que muestra la aplicación.')
  }
  let codes = null
  const passed = await guardedCheck(db, session.userId, async () => (codes = await completeSetup(db, session.userId, body.code)))
  if (passed !== true) {
    await audit(db, { req, session, action: 'mfa.enable', result: 'failed', targetType: 'user', targetId: session.userId })
    if (passed === 'locked') throw new HttpError(429, 'locked', LOCKED_IN_SESSION)
    throw badRequest('El código no coincide. Revisá que la hora del teléfono sea la correcta y probá con el siguiente.')
  }
  // This session now has both factors; others were opened with one.
  await db.query('UPDATE console_sessions SET enrollment_only = false WHERE token_hash = $1', [session.tokenHash])
  await revokeUserSessions(db, session.userId, session.tokenHash)
  await audit(db, { req, session, action: 'mfa.enable', targetType: 'user', targetId: session.userId })
  return json({ ok: true, recovery_codes: codes })
}, { duringEnrollment: true })
