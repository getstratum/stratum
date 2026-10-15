/**
 * lib/users.js — shared pieces of the people and agents routes.
 */

import { createHash, randomBytes } from 'node:crypto'
import { assignableRoles } from './authz.js'
import { forbidden, notFound, isUuid } from './route.js'

// Columns a console API may return about a user. Never password or key hashes.
export const USER_COLUMNS = `
  u.id, u.email, u.name, u.role, COALESCE(u.is_active, true) AS is_active,
  u.api_key_prefix, u.created_at, u.last_login_at,
  (u.password_hash IS NOT NULL) AS has_password,
  (u.api_key_hash  IS NOT NULL) AS has_api_key,
  t.id AS team_id, t.name AS team_name`

export function newApiKey(prefix) {
  const raw = `${prefix}${randomBytes(24).toString('hex')}`
  return {
    raw,
    hash:   createHash('sha256').update(raw).digest('hex'),
    prefix: raw.slice(0, prefix.length + 6) + '...',
  }
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
export const validEmail = (e) => typeof e === 'string' && e.length <= 254 && EMAIL_RE.test(e)

/**
 * The user `id` as the session may act on it, or 404/403:
 *   - another organization's user does not exist (404);
 *   - a 'team' scope only reaches users of the session's team (404);
 *   - a user whose current role the actor could not assign is out of reach
 *     (an admin cannot change an owner, a team manager only members).
 */
export async function loadManagedUser(db, session, id) {
  if (!isUuid(id)) throw notFound('Usuario no encontrado.')
  const { rows } = await db.query(
    `SELECT u.id, u.email, u.role, COALESCE(u.is_active, true) AS is_active,
            u.team_id::text AS team_id
       FROM users u WHERE u.id = $1 AND u.org_id = $2`,
    [id, session.orgId])
  const u = rows[0]
  if (!u) throw notFound('Usuario no encontrado.')
  if (session.scope === 'team' && u.team_id !== session.teamId) throw notFound('Usuario no encontrado.')
  if (!assignableRoles(session.role).includes(u.role)) {
    throw forbidden('Tu rol no puede modificar a esta persona.')
  }
  return u
}

/** Fails if no other active owner would remain once `userId` stops being one. */
export async function assertAnotherOwner(db, orgId, userId) {
  const { rows } = await db.query(
    `SELECT count(*)::int AS n FROM users
      WHERE org_id = $1 AND role = 'owner' AND COALESCE(is_active, true) AND id <> $2`,
    [orgId, userId])
  if (rows[0].n === 0) throw forbidden('La organización tiene que conservar al menos un Owner activo.')
}

// Columns a console API may return about an agent. Never the key hash.
export const AGENT_COLUMNS = `
  a.id, a.name, a.description, a.api_key_prefix, a.is_active, a.created_at,
  a.default_model, a.default_provider,
  t.id AS team_id, t.name AS team_name`
