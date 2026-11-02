/**
 * lib/service-tokens.js — the console's API for automation (migration 036).
 *
 *   Authorization: Bearer stsvc_<random>
 *
 * A token carries a name, the permissions it was given (SCOPES, a subset of
 * lib/authz.js) and an expiry of at most a year. It acts on the whole
 * organization with role 'service': lib/route.js lets it through a route
 * only if the route's permission is one of its scopes and the route does
 * not opt out (sign-in, the account, second factors, tokens themselves).
 * Never as a person: no passwords, no Owners (lib/authz.js
 * assignableRoles), no tokens. What it does is in the audit log as
 * "token:<name>".
 */

import { randomBytes } from 'node:crypto'
import { hashToken } from './session.js'
import { badRequest } from './route.js'

export const PREFIX = 'stsvc_'
export const MAX_DAYS = 365
export const EXPIRY_CHOICES = [30, 90, 180, 365]

// What a token may be given. Left out on purpose: the session's own routes
// (org.read), anything that holds or hands out a secret of the organization
// (providers, gateways, applications, SSO) and tokens themselves.
export const SCOPES = [
  'users.read', 'users.manage', 'keys.manage',
  'teams.read', 'teams.manage', 'teams.budget',
  'policies.read', 'policies.manage',
  'alerts.read', 'alerts.manage',
  'models.read', 'models.manage',
  'providers.read', 'gateways.read', 'apps.read', 'sso.read',
  'usage.read', 'logs.read', 'audit.read',
]

/** A Bearer token that looks like a service token, or null. */
export function bearerToken(req) {
  const h = req.headers.get('authorization') ?? ''
  const m = /^bearer\s+(\S+)$/i.exec(h.trim())
  if (!m || !m[1].startsWith(PREFIX) || m[1].length > 128) return null
  return m[1]
}

/** { name, scopes, days } from a request body, or a 400. */
export function parseNewToken(body) {
  const name = typeof body?.name === 'string' ? body.name.trim() : ''
  if (!name || name.length > 100) throw badRequest('El nombre es obligatorio (hasta 100 caracteres).')
  const scopes = Array.isArray(body?.scopes) ? [...new Set(body.scopes)] : []
  if (!scopes.length) throw badRequest('Elegí al menos un permiso.')
  const unknown = scopes.filter(s => !SCOPES.includes(s))
  if (unknown.length) throw badRequest(`Permisos que un token no puede tener: ${unknown.join(', ')}.`)
  const days = body?.expiresInDays ?? 90
  if (!Number.isInteger(days) || days < 1 || days > MAX_DAYS) throw badRequest(`El vencimiento va de 1 a ${MAX_DAYS} días.`)
  return { name, scopes: SCOPES.filter(s => scopes.includes(s)), days }
}

export const TOKEN_COLUMNS = `t.id, t.name, t.token_prefix, t.scopes, t.created_at, t.expires_at,
  t.last_used_at, t.revoked_at, u.email AS created_by_email`

/** Makes a token; the raw value is in the answer, this once. */
export async function createToken(db, { orgId, userId }, { name, scopes, days }) {
  const raw = `${PREFIX}${randomBytes(32).toString('base64url')}`
  const { rows: [t] } = await db.query(
    `INSERT INTO service_tokens (org_id, name, token_hash, token_prefix, scopes, created_by, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, now() + make_interval(days => $7))
     RETURNING id`,
    [orgId, name, hashToken(raw), raw.slice(0, PREFIX.length + 6), scopes, userId ?? null, days])
  return { id: t.id, raw }
}

/**
 * The session a service token stands for, or null: not revoked, not
 * expired, its organization active. Touches last_used_at at most once a
 * minute.
 */
export async function loadServiceSession(db, raw) {
  if (typeof raw !== 'string' || !raw.startsWith(PREFIX)) return null
  const { rows: [t] } = await db.query(
    `UPDATE service_tokens t
        SET last_used_at = CASE WHEN t.last_used_at IS NULL OR t.last_used_at < now() - interval '1 minute'
                                THEN now() ELSE t.last_used_at END
       FROM organizations o
      WHERE t.token_hash = $1 AND o.id = t.org_id AND o.status = 'active'
        AND t.revoked_at IS NULL AND t.expires_at > now()
      RETURNING t.id, t.org_id, t.name, t.scopes, o.name AS org_name`,
    [hashToken(raw)])
  if (!t) return null
  return {
    service: { id: t.id, name: t.name, scopes: t.scopes },
    userId: null, orgId: t.org_id, orgName: t.org_name, teamId: null,
    email: `token:${t.name}`, name: t.name, role: 'service',
  }
}
