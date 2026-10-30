// POST /api/oidc/login  { i, email, password } — the password step of a
// sign-in to an application (lib/oidc.js).
//
// Answers, like the console's own sign-in, one 401 for every refusal, so it
// never tells whether an email has an account or why it may not sign in;
// the reason is in the audit log. Then:
//   { redirect }                         done: send the browser there
//   { mfa_required, challenge }          the second factor comes next
//   { mfa_enrollment_required, challenge, secret, uri, qr_svg }
//                                        the application asks for a second
//                                        factor the person has not set up:
//                                        they set it up here
export const dynamic = 'force-dynamic'
import { getDb } from '../../../../lib/db.js'
import { publicRoute, readJson, json, notFound } from '../../../../lib/route.js'
import { verifyPassword, needsRehash, hashPassword } from '../../../../lib/password.js'
import { reserveAttempt, recordFailure, recordSuccess, INVALID } from '../../../../lib/login.js'
import { startChallenge, beginSetup } from '../../../../lib/mfa.js'
import { qrSvg } from '../../../../lib/qr.js'
import { audit } from '../../../../lib/audit.js'
import { loadInteraction, finishInteraction, appUser, EXPIRED } from '../../../../lib/oidc.js'
import { passwordRefused } from '../../../../lib/sso.js'

export const POST = publicRoute(async (req) => {
  const db = getDb()
  const body = await readJson(req)
  const interaction = await loadInteraction(db, body.i)
  if (!interaction) throw notFound(EXPIRED)

  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : ''
  const { rows: [u] } = await db.query(
    `SELECT u.id, u.org_id::text AS org_id, u.email, u.password_hash, u.totp_enabled_at
       FROM users u WHERE lower(u.email) = $1 LIMIT 1`, [email])
  const reserved = u ? await reserveAttempt(db, u.id) : null
  const ok = await verifyPassword(body.password, u?.password_hash)

  const refuse = async (reason) => {
    await audit(db, {
      req, orgId: interaction.org_id, actor: u?.email ?? (email.slice(0, 200) || null),
      action: 'app.login', result: 'failed', targetType: 'oidc_client', targetId: interaction.client_id,
      details: { reason },
    })
    return json({ error: 'invalid_credentials', message: INVALID }, 401)
  }
  if (!u) return refuse('unknown_email')
  if (!reserved) return refuse('locked')
  if (!ok) {
    await recordFailure(db, u.id, reserved)
    return refuse('bad_password')
  }
  // Another organization's person, deactivated, without a team or without
  // access to applications: the same refusal.
  if (u.org_id !== interaction.org_id) return refuse('other_organization')
  if (!await appUser(db, u.id, interaction.org_id)) return refuse('no_app_access')
  const { rows: [{ role }] } = await db.query('SELECT role FROM users WHERE id = $1', [u.id])
  if (await passwordRefused(db, { email: u.email, orgId: u.org_id, role })) {
    await audit(db, {
      req, orgId: interaction.org_id, actor: u.email, action: 'app.login', result: 'failed',
      targetType: 'oidc_client', targetId: interaction.client_id, details: { reason: 'sso_required' },
    })
    return json({ error: 'sso_required', message: 'Tu organización ingresa con su proveedor de identidad: usá «Entrar con SSO».' }, 401)
  }

  if (needsRehash(u.password_hash)) {
    await db.query('UPDATE users SET password_hash = $2 WHERE id = $1', [u.id, await hashPassword(body.password)])
  }

  if (u.totp_enabled_at || interaction.require_mfa) {
    await db.query('UPDATE oidc_interactions SET user_id = $2 WHERE id_hash = $1', [interaction.id_hash, u.id])
    const challenge = await startChallenge(db, u.id)
    await audit(db, {
      req, orgId: interaction.org_id, actor: u.email, action: 'app.password_ok',
      targetType: 'oidc_client', targetId: interaction.client_id,
      details: { next: u.totp_enabled_at ? 'second_factor' : 'second_factor_setup' },
    })
    if (u.totp_enabled_at) return json({ mfa_required: true, challenge })
    const { secret, uri } = await beginSetup(db, { userId: u.id, email: u.email })
    return json({ mfa_enrollment_required: true, challenge, secret, uri, qr_svg: qrSvg(uri) })
  }

  if (!await recordSuccess(db, u.id)) return refuse('locked')
  const redirect = await finishInteraction(db, interaction, u.id, ['pwd'])
  if (!redirect) throw notFound(EXPIRED)
  await audit(db, {
    req, orgId: interaction.org_id, actor: u.email, action: 'app.login',
    targetType: 'oidc_client', targetId: interaction.client_id, details: { amr: ['pwd'] },
  })
  return json({ redirect })
})
