// POST /api/oidc/login/mfa  { i, challenge, code } — the second step of a
// sign-in to an application: a code from the authenticator or a recovery
// code, or, for someone setting the authenticator up during this sign-in,
// its first code (then the answer carries the recovery codes, shown once).
export const dynamic = 'force-dynamic'
import { getDb } from '../../../../../lib/db.js'
import { publicRoute, readJson, json, notFound } from '../../../../../lib/route.js'
import { reserveAttempt, recordFailure, recordSuccess } from '../../../../../lib/login.js'
import { useChallenge, endChallenge, checkSecondFactor, completeSetup } from '../../../../../lib/mfa.js'
import { audit } from '../../../../../lib/audit.js'
import { loadInteraction, finishInteraction, appUser, EXPIRED, CODE_SECONDS, CODE_SECONDS_AFTER_SETUP } from '../../../../../lib/oidc.js'

const INVALID_CODE = 'Código incorrecto o vencido. Si pasaron más de 5 minutos, volvé a ingresar la contraseña.'

export const POST = publicRoute(async (req) => {
  const db = getDb()
  const body = await readJson(req)
  const interaction = await loadInteraction(db, body.i)
  if (!interaction) throw notFound(EXPIRED)

  const userId = await useChallenge(db, body.challenge)
  const refuse = async (reason, u) => {
    await audit(db, {
      req, orgId: interaction.org_id, actor: u?.email ?? null, action: 'app.login', result: 'failed',
      targetType: 'oidc_client', targetId: interaction.client_id, details: { reason, step: 'second_factor' },
    })
    return json({ error: 'invalid_code', message: INVALID_CODE }, 401)
  }
  // The challenge must be the one this interaction's password step made.
  if (!userId || userId !== interaction.user_id) return refuse('unknown_or_expired_challenge')

  const { rows: [u] } = await db.query('SELECT id, email, totp_enabled_at FROM users WHERE id = $1', [userId])
  const reserved = await reserveAttempt(db, u.id)
  if (!reserved) return refuse('locked', u)

  let method = null
  let recoveryCodes
  if (u.totp_enabled_at) {
    method = await checkSecondFactor(db, u.id, body.code)
  } else {
    const typed = String(body.code ?? '').replace(/\s/g, '')
    recoveryCodes = /^\d{6}$/.test(typed) ? await completeSetup(db, u.id, typed) : null
    if (recoveryCodes) method = 'totp_setup'
  }
  if (!method) {
    await recordFailure(db, u.id, reserved)
    return refuse('bad_code', u)
  }
  if (!await appUser(db, u.id, interaction.org_id)) return refuse('no_app_access', u)
  if (!await recordSuccess(db, u.id)) return refuse('locked', u)
  await endChallenge(db, body.challenge)

  const redirect = await finishInteraction(db, interaction, u.id, ['pwd', 'otp'],
    method === 'totp_setup' ? CODE_SECONDS_AFTER_SETUP : CODE_SECONDS)
  if (!redirect) throw notFound(EXPIRED)
  if (method === 'totp_setup') {
    await audit(db, { req, orgId: interaction.org_id, actor: u.email, action: 'mfa.enable', targetType: 'user', targetId: u.id,
      details: { during: 'app.login' } })
  }
  await audit(db, {
    req, orgId: interaction.org_id, actor: u.email, action: 'app.login',
    targetType: 'oidc_client', targetId: interaction.client_id, details: { amr: ['pwd', 'otp'], mfa: method },
  })
  return json({ redirect, ...(recoveryCodes ? { recovery_codes: recoveryCodes } : {}) })
})
