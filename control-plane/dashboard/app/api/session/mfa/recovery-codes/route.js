export const dynamic = 'force-dynamic'
import { route, readJson, json, forbidden, badRequest, HttpError } from '../../../../../lib/route.js'
import { guardedCheck, LOCKED_IN_SESSION } from '../../../../../lib/login.js'
import { audit } from '../../../../../lib/audit.js'
import { checkSecondFactor, replaceRecoveryCodes } from '../../../../../lib/mfa.js'

// POST /api/session/mfa/recovery-codes  { code } → new recovery codes; the
// old ones stop working. Needs a code from the authenticator.
export const POST = route('org.read', async (req, { session, db }) => {
  const body = await readJson(req)
  // Only a code from the app: checking a recovery code here would use it up.
  if (typeof body.code !== 'string' || !/^\d{6}$/.test(body.code.replace(/\s/g, ''))) {
    throw badRequest('Ingresá los 6 dígitos de la aplicación, no un código de recuperación.')
  }
  const passed = await guardedCheck(db, session.userId, async () => (await checkSecondFactor(db, session.userId, body.code)) === 'totp')
  if (passed !== true) {
    await audit(db, { req, session, action: 'mfa.recovery_codes', result: 'failed', targetType: 'user', targetId: session.userId })
    if (passed === 'locked') throw new HttpError(429, 'locked', LOCKED_IN_SESSION)
    throw forbidden('Código incorrecto.')
  }
  const codes = await replaceRecoveryCodes(db, session.userId)
  await audit(db, { req, session, action: 'mfa.recovery_codes', targetType: 'user', targetId: session.userId })
  return json({ recovery_codes: codes })
})
