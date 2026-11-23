/**
 * lib/platform.js — the platform API's tokens (ADR-0020, migration 048).
 *
 *   Authorization: Bearer stplat_<random>
 *   X-Stratum-Actor: ana@matech.lat          (optional)
 *
 * A platform token belongs to no organization. Routes under /api/platform
 * take it through platformRoute() (lib/route.js), and nothing else does: a
 * platform token opens no organization's routes, and a session or service
 * token opens no platform route. What a token does is in platform_audit as
 * "platform:<name>"; a client that acts for several people (stratum-operator)
 * says who in X-Stratum-Actor, which is recorded next to it. The token is
 * what is trusted; the header only names.
 *
 * Runs in Next.js and in scripts/stratum-admin.mjs.
 */

import { createHash, randomBytes } from 'node:crypto'
import { HttpError } from './http-error.js'

export const PREFIX = 'stplat_'
export const MAX_DAYS = 365

const hash = (raw) => createHash('sha256').update(raw).digest('hex')

/** A Bearer token that looks like a platform token, or null. */
export function platformBearer(req) {
  const h = req.headers.get('authorization') ?? ''
  const m = /^bearer\s+(\S+)$/i.exec(h.trim())
  if (!m || !m[1].startsWith(PREFIX) || m[1].length > 128) return null
  return m[1]
}

/** Who the audit logs say did it: the token, and whom its client names. */
export function actorOf(token, req) {
  const named = (req.headers.get('x-stratum-actor') ?? '').trim()
  const ok = /^[\p{L}\p{N} @._+'-]{1,100}$/u.test(named)
  return `platform:${token.name}${ok ? ` (${named})` : ''}`
}

/** Makes a token; the raw value is returned this once. */
export async function createPlatformToken(db, { name, days = 90 }) {
  const n = typeof name === 'string' ? name.trim() : ''
  if (!n || n.length > 100) throw new HttpError(400, 'bad_name', 'The token needs a name (up to 100 characters).')
  if (!Number.isInteger(days) || days < 1 || days > MAX_DAYS) throw new HttpError(400, 'bad_days', `The expiry goes from 1 to ${MAX_DAYS} days.`)
  const raw = `${PREFIX}${randomBytes(32).toString('base64url')}`
  const { rows: [t] } = await db.query(
    `INSERT INTO platform_tokens (name, token_hash, token_prefix, expires_at)
     VALUES ($1, $2, $3, now() + make_interval(days => $4)) RETURNING id, expires_at`,
    [n, hash(raw), raw.slice(0, PREFIX.length + 6), days])
  return { id: t.id, name: n, raw, expiresAt: t.expires_at }
}

/** The token behind a raw value, or null: not revoked, not expired. Touches last_used_at at most once a minute. */
export async function loadPlatformToken(db, raw) {
  if (typeof raw !== 'string' || !raw.startsWith(PREFIX)) return null
  const { rows: [t] } = await db.query(
    `UPDATE platform_tokens
        SET last_used_at = CASE WHEN last_used_at IS NULL OR last_used_at < now() - interval '1 minute'
                                THEN now() ELSE last_used_at END
      WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now()
      RETURNING id, name`, [hash(raw)])
  return t ?? null
}

export async function listPlatformTokens(db) {
  const { rows } = await db.query(
    `SELECT id, name, token_prefix, created_at, expires_at, last_used_at, revoked_at
       FROM platform_tokens ORDER BY created_at DESC`)
  return rows
}

/** Revokes a token by id; false if there is none that works. */
export async function revokePlatformToken(db, id) {
  if (!/^[0-9a-f-]{36}$/i.test(String(id))) return false
  const { rowCount } = await db.query(
    'UPDATE platform_tokens SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL', [id])
  return rowCount > 0
}

/** Runs fn(client) on one connection of the pool, for the functions that run their own transaction. */
export async function withClient(pool, fn) {
  const client = await pool.connect()
  try {
    return await fn(client)
  } finally {
    client.release()
  }
}
