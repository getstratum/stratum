/**
 * lib/mfa.js — the console's second factor (migration 022).
 *
 * Owner and Admin must use it; the other console roles may. Sign-in with it
 * is two requests: the password returns a challenge (no session yet), then
 * the challenge and a code from the authenticator, or a recovery code,
 * return the session.
 */

import { createHash, randomBytes } from 'node:crypto'
import { encryptSecret, decryptSecret } from './secrets.js'
import { hashPassword, verifyPassword } from './password.js'
import {
  newSecret, matchStep, otpauthUri, newRecoveryCodes, normalizeRecoveryCode, looksLikeRecoveryCode,
} from './totp.js'

export const MFA_REQUIRED_ROLES = ['owner', 'admin']
export const mfaRequired = (role) => MFA_REQUIRED_ROLES.includes(role)

const CHALLENGE_MINUTES = 5
const CHALLENGE_ATTEMPTS = 5

const hash = (v) => createHash('sha256').update(v).digest('hex')

/** After a correct password: a challenge for the second step. */
export async function startChallenge(db, userId) {
  const token = randomBytes(32).toString('base64url')
  await db.query('DELETE FROM console_login_challenges WHERE user_id = $1 OR expires_at < now()', [userId])
  await db.query(
    `INSERT INTO console_login_challenges (challenge_hash, user_id, expires_at)
     VALUES ($1, $2, now() + make_interval(mins => $3))`,
    [hash(token), userId, CHALLENGE_MINUTES])
  return token
}

/**
 * Counts one try against a challenge and returns its user ID, or null when
 * the challenge is unknown, expired or out of tries.
 */
export async function useChallenge(db, token) {
  if (typeof token !== 'string' || token.length < 32 || token.length > 128) return null
  const { rows } = await db.query(
    `UPDATE console_login_challenges SET attempts = attempts + 1
      WHERE challenge_hash = $1 AND expires_at > now() AND attempts < $2
      RETURNING user_id`,
    [hash(token), CHALLENGE_ATTEMPTS])
  return rows[0]?.user_id ?? null
}

export async function endChallenge(db, token) {
  await db.query('DELETE FROM console_login_challenges WHERE challenge_hash = $1', [hash(token)])
}

/**
 * Checks a code from the authenticator (each one works once) or a recovery
 * code (each one works once). Returns 'totp', 'recovery_code' or null.
 */
export async function checkSecondFactor(db, userId, code) {
  const { rows: [u] } = await db.query(
    'SELECT totp_secret_encrypted, totp_last_step FROM users WHERE id = $1 AND totp_enabled_at IS NOT NULL', [userId])
  if (!u?.totp_secret_encrypted) return null

  const typed = String(code ?? '').trim()
  if (/^\d{6}$/.test(typed.replace(/\s/g, ''))) {
    let secret
    try {
      secret = decryptSecret(u.totp_secret_encrypted)
    } catch {
      return null
    }
    const step = matchStep(secret, typed)
    if (step == null) return null
    // Atomic: two requests with the same code cannot both pass.
    const { rowCount } = await db.query(
      'UPDATE users SET totp_last_step = $2 WHERE id = $1 AND totp_last_step < $2', [userId, step])
    return rowCount ? 'totp' : null
  }

  if (looksLikeRecoveryCode(typed)) {
    const { rows } = await db.query(
      'SELECT id, code_hash FROM user_recovery_codes WHERE user_id = $1 AND used_at IS NULL', [userId])
    const plain = normalizeRecoveryCode(typed)
    for (const r of rows) {
      if (await verifyPassword(plain, r.code_hash)) {
        const { rowCount } = await db.query(
          'UPDATE user_recovery_codes SET used_at = now() WHERE id = $1 AND used_at IS NULL', [r.id])
        return rowCount ? 'recovery_code' : null
      }
    }
  }
  return null
}

/** Starts setting up an authenticator: a new pending secret. */
export async function beginSetup(db, user) {
  const secret = newSecret()
  await db.query('UPDATE users SET totp_pending_secret_encrypted = $2 WHERE id = $1', [user.userId, encryptSecret(secret)])
  return { secret, uri: otpauthUri({ secret, account: user.email }) }
}

/**
 * Finishes the setup with a first code from the pending secret. Returns the
 * new recovery codes (shown once), or null when the code is wrong.
 */
export async function completeSetup(db, userId, code) {
  const { rows: [u] } = await db.query('SELECT totp_pending_secret_encrypted FROM users WHERE id = $1', [userId])
  if (!u?.totp_pending_secret_encrypted) return null
  const secret = decryptSecret(u.totp_pending_secret_encrypted)
  const step = matchStep(secret, code)
  if (step == null) return null
  const { rowCount } = await db.query(
    `UPDATE users SET totp_secret_encrypted = totp_pending_secret_encrypted, totp_pending_secret_encrypted = NULL,
                      totp_enabled_at = now(), totp_last_step = $2
      WHERE id = $1 AND totp_pending_secret_encrypted = $3`,
    [userId, step, u.totp_pending_secret_encrypted])
  if (!rowCount) return null
  return replaceRecoveryCodes(db, userId)
}

export async function replaceRecoveryCodes(db, userId) {
  const codes = newRecoveryCodes()
  const hashes = await Promise.all(codes.map(c => hashPassword(normalizeRecoveryCode(c))))
  await db.query('DELETE FROM user_recovery_codes WHERE user_id = $1', [userId])
  await db.query(
    'INSERT INTO user_recovery_codes (user_id, code_hash) SELECT $1, unnest($2::text[])', [userId, hashes])
  return codes
}

/** Turns the second factor off (own choice, or an administrator's reset). */
export async function disable(db, userId) {
  await db.query(
    `UPDATE users SET totp_secret_encrypted = NULL, totp_pending_secret_encrypted = NULL,
                      totp_enabled_at = NULL WHERE id = $1`, [userId])
  await db.query('DELETE FROM user_recovery_codes WHERE user_id = $1', [userId])
  await db.query('DELETE FROM console_login_challenges WHERE user_id = $1', [userId])
}

/** What the account page shows. */
export async function status(db, userId) {
  const { rows: [u] } = await db.query(
    `SELECT totp_enabled_at,
            (SELECT count(*)::int FROM user_recovery_codes r WHERE r.user_id = u.id AND r.used_at IS NULL) AS codes_left
       FROM users u WHERE id = $1`, [userId])
  return { enabled: !!u?.totp_enabled_at, enabledAt: u?.totp_enabled_at ?? null, recoveryCodesLeft: u?.codes_left ?? 0 }
}
