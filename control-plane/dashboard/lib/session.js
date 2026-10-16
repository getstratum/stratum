/**
 * lib/session.js — console sessions, kept in console_sessions.
 *
 * The cookie holds 32 random bytes; the database holds their SHA-256. A
 * session ends when it is revoked (logout, the user is deactivated or their
 * role changes), after STRATUM_SESSION_IDLE_MINUTES without use (default 30)
 * or STRATUM_SESSION_MAX_HOURS after sign-in (default 12), whichever comes
 * first. It is also refused when the user or the organization stops being
 * active or the role loses console access, without waiting for any of that.
 */

import { createHash, randomBytes } from 'node:crypto'
import { CONSOLE_ROLES } from './authz.js'
import { COOKIE } from './session-cookie.js'

export { COOKIE }

function minutesEnv(name, fallback) {
  const v = Number(process.env[name])
  return Number.isFinite(v) && v > 0 ? v : fallback
}
const idleMinutes = () => minutesEnv('STRATUM_SESSION_IDLE_MINUTES', 30)
const maxHours    = () => minutesEnv('STRATUM_SESSION_MAX_HOURS', 12)

export const hashToken = (token) => createHash('sha256').update(token).digest('hex')

/**
 * enrollmentOnly: a session of an Owner or Admin who has not set up the
 * second factor yet. lib/route.js lets it reach only the routes that set it
 * up (migration 022).
 */
export async function createSession(db, { userId, orgId, ip, userAgent, enrollmentOnly = false }) {
  const token = randomBytes(32).toString('base64url')
  await db.query(
    `INSERT INTO console_sessions (token_hash, user_id, org_id, expires_at, ip, user_agent, enrollment_only)
     VALUES ($1, $2, $3, now() + make_interval(hours => $4), $5, $6, $7)`,
    [hashToken(token), userId, orgId, maxHours(), ip ?? null, userAgent?.slice(0, 300) ?? null, enrollmentOnly])
  return token
}

/** The session for `token`, or null. Refreshes its idle timer. */
export async function loadSession(db, token) {
  if (typeof token !== 'string' || token.length < 32 || token.length > 128) return null
  const tokenHash = hashToken(token)
  const { rows } = await db.query(
    `SELECT s.token_hash, s.user_id, s.org_id, s.last_seen_at, s.enrollment_only,
            u.email, u.name, u.role, u.team_id::text AS team_id,
            o.name AS org_name
       FROM console_sessions s
       JOIN users u         ON u.id = s.user_id
       JOIN organizations o ON o.id = s.org_id
      WHERE s.token_hash = $1
        AND s.revoked_at IS NULL
        AND s.expires_at > now()
        AND s.last_seen_at > now() - make_interval(mins => $2)
        AND u.org_id = s.org_id
        AND COALESCE(u.is_active, true)
        AND o.status = 'active'
        AND u.role = ANY($3)`,
    [tokenHash, idleMinutes(), CONSOLE_ROLES])
  const r = rows[0]
  if (!r) return null
  // One write a minute is enough for a 30-minute idle timeout.
  if (Date.now() - new Date(r.last_seen_at).getTime() > 60_000) {
    await db.query('UPDATE console_sessions SET last_seen_at = now() WHERE token_hash = $1', [tokenHash])
  }
  return {
    tokenHash,
    userId:  r.user_id,
    orgId:   r.org_id,
    orgName: r.org_name,
    email:   r.email,
    name:    r.name,
    role:    r.role,
    teamId:  r.team_id,
    enrollmentOnly: r.enrollment_only,
  }
}

export async function revokeSession(db, token) {
  if (typeof token !== 'string') return
  await db.query(
    'UPDATE console_sessions SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL',
    [hashToken(token)])
}

/** Ends every session of a user, except the one with `exceptHash`. */
export async function revokeUserSessions(db, userId, exceptHash = null) {
  await db.query(
    `UPDATE console_sessions SET revoked_at = now()
      WHERE user_id = $1 AND revoked_at IS NULL AND token_hash IS DISTINCT FROM $2`,
    [userId, exceptHash])
}

export function cookieOptions() {
  return {
    httpOnly: true,
    // Secure unless explicitly turned off for plain-HTTP development.
    secure:   process.env.SECURE_COOKIES !== 'false' && process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path:     '/',
    maxAge:   maxHours() * 3600,
  }
}
