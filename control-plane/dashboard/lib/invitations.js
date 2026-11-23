/**
 * lib/invitations.js — invitations (ADR-0020, migration 049).
 *
 * A link that works once, for 72 hours, where someone sets their own
 * password; then the console asks for the second factor if their role
 * requires one. The link is <console>/invite#<token>: the token goes in the
 * fragment, which browsers never send to a server, so it is in no access
 * log. Only its SHA-256 is kept.
 *
 * The account is created on acceptance: until then the invitation does not
 * count against the plan, and the email stays free. Accepting checks the
 * plan's people again, under the same lock as adding someone.
 *
 * Messages are for people, in Spanish; the platform API rewrites them by
 * code (app/api/platform/organizations/[id]/invitations). Runs in
 * scripts/stratum-admin.mjs too, which only creates and sends: lib/sso.js
 * (which needs Next.js) is loaded only to look up and accept.
 */

import { createHash, randomBytes } from 'node:crypto'
import { HttpError } from './http-error.js'
import { hashPassword, passwordProblem } from './password.js'
import { assertRoom, lockKey } from './org-limits.js'
import { alertConfig, deliver } from './alert-delivery.js'

// lib/sso.js imports lib/route.js, which needs Next.js.
const passwordRefused = async (...args) => (await import('./sso.js')).passwordRefused(...args)

export const TTL_HOURS = 72
const PREFIX = 'stinv_'
const hash = (raw) => createHash('sha256').update(raw).digest('hex')
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

const ROLE_NAMES = { owner: 'Owner', admin: 'Admin', team_manager: 'gestor de equipo', auditor: 'Auditor', member: 'integrante' }

/**
 * Where links point: STRATUM_CONSOLE_URL, or else the address the request
 * came to. Set the variable when the console is behind a proxy that does not
 * pass the host it was asked for.
 */
export function baseUrl(req, env = process.env) {
  const fixed = (env.STRATUM_CONSOLE_URL ?? '').trim().replace(/\/+$/, '')
  if (fixed) return fixed
  if (!req) throw new HttpError(500, 'no_console_url', 'Falta STRATUM_CONSOLE_URL: sin ella no se puede armar el enlace.')
  return new URL(req.url).origin
}

export const linkFor = (base, raw) => `${base}/invite#${raw}`

const invalid = () => new HttpError(410, 'invitation_invalid',
  'La invitación no sirve: ya se usó, venció o la reemplazaron por otra. Pedile una nueva a quien te invitó.')

/**
 * Creates an invitation, replacing the open one for the same email in the
 * organization. Takes one connection (runs a transaction). Returns
 * { id, email, role, expiresAt, raw }.
 */
export async function createInvitation(db, { orgId, email, role = 'owner', teamId = null, invitedBy }) {
  const e = typeof email === 'string' ? email.trim().toLowerCase() : ''
  if (!EMAIL_RE.test(e) || e.length > 254) throw new HttpError(400, 'bad_email', 'Email inválido.')
  if (!ROLE_NAMES[role]) throw new HttpError(400, 'bad_role', 'Rol inválido.')
  if (role === 'team_manager' && !teamId) throw new HttpError(400, 'team_required', 'Un gestor de equipo necesita un equipo.')
  await db.query('BEGIN')
  try {
    const { rows: [org] } = await db.query('SELECT id, name, status, delete_after FROM organizations WHERE id = $1', [orgId])
    if (!org) throw new HttpError(404, 'not_found', 'La organización no existe.')
    if (org.status !== 'active' || org.delete_after) {
      throw new HttpError(409, 'org_unavailable', 'La organización está suspendida: nadie de ella puede entrar, así que no se invita a nadie.')
    }
    const { rows: [taken] } = await db.query('SELECT 1 FROM users WHERE lower(email) = $1', [e])
    if (taken) throw new HttpError(409, 'email_taken', 'Ya existe una cuenta con ese email.')
    await db.query(
      `UPDATE invitations SET revoked_at = now()
        WHERE org_id = $1 AND lower(email) = $2 AND accepted_at IS NULL AND revoked_at IS NULL`, [org.id, e])
    const raw = `${PREFIX}${randomBytes(32).toString('base64url')}`
    const { rows: [inv] } = await db.query(
      `INSERT INTO invitations (org_id, email, role, team_id, token_hash, invited_by, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, now() + make_interval(hours => $7))
       RETURNING id, expires_at`,
      [org.id, e, role, teamId, hash(raw), invitedBy, TTL_HOURS])
    await db.query('COMMIT')
    return { id: inv.id, email: e, role, orgName: org.name, expiresAt: inv.expires_at, raw }
  } catch (err) {
    await db.query('ROLLBACK').catch(() => {})
    throw err
  }
}

/** The email that carries the link. */
export function invitationMessage({ orgName, role, link, expiresAt }) {
  const until = new Date(expiresAt).toISOString().replace('T', ' ').slice(0, 16)
  return {
    subject: `Te invitaron a ${orgName} en Stratum`,
    text: [
      `Te invitaron a la organización ${orgName} en Stratum, como ${ROLE_NAMES[role]}.`,
      '',
      'Para entrar, abrí este enlace y elegí tu contraseña:',
      link,
      '',
      `Sirve una sola vez, hasta el ${until} (UTC). Nadie más conoce la contraseña que elijas.`,
      'Si no esperabas esta invitación, ignorá este mensaje.',
    ].join('\n'),
  }
}

/**
 * Sends the link by email when the console has SMTP (STRATUM_SMTP_URL).
 * Returns { sent: true } or { sent: false, reason }; never throws.
 */
export async function sendInvitation(inv, link, { cfg = alertConfig(), deps = {} } = {}) {
  if (!cfg.smtpUrl) return { sent: false, reason: 'no_smtp' }
  try {
    await deliver({ channel: 'email', destination: inv.email },
      invitationMessage({ orgName: inv.orgName, role: inv.role, link, expiresAt: inv.expiresAt }), cfg, deps)
    return { sent: true }
  } catch (err) {
    return { sent: false, reason: err.message }
  }
}

/** What the invitation page shows before someone accepts: null if it does not work. */
export async function lookupInvitation(db, raw) {
  if (typeof raw !== 'string' || !raw.startsWith(PREFIX) || raw.length > 100) return null
  const { rows: [i] } = await db.query(
    `SELECT i.email, i.role, i.expires_at, i.org_id, o.name AS org_name
       FROM invitations i JOIN organizations o ON o.id = i.org_id
      WHERE i.token_hash = $1 AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now()
        AND o.status = 'active' AND o.delete_after IS NULL`, [hash(raw)])
  if (!i) return null
  return {
    email: i.email, role: i.role, org: i.org_name, expires_at: i.expires_at,
    // The organization signs in with its identity provider: no password to choose.
    sso: await passwordRefused(db, { email: i.email, orgId: i.org_id, role: i.role }),
  }
}

/**
 * Accepts an invitation: creates the account with the password its person
 * chose (none if the organization signs in with SSO) and spends the link.
 * Takes a pool. Returns the new user { id, org_id, email, role, sso }.
 */
export async function acceptInvitation(pool, { raw, name, password }) {
  if (typeof raw !== 'string' || !raw.startsWith(PREFIX) || raw.length > 100) throw invalid()
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const { rows: [i] } = await client.query(
      `SELECT i.id, i.org_id, i.email, i.role, i.team_id
         FROM invitations i JOIN organizations o ON o.id = i.org_id
        WHERE i.token_hash = $1 AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now()
          AND o.status = 'active' AND o.delete_after IS NULL
        FOR UPDATE OF i`, [hash(raw)])
    if (!i) throw invalid()
    // The same lock as adding a person, so the plan's limit holds.
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [lockKey('people', i.org_id)])
    const { rows: [taken] } = await client.query('SELECT 1 FROM users WHERE lower(email) = $1', [i.email])
    if (taken) throw new HttpError(409, 'email_taken', 'Ya existe una cuenta con ese email: ingresá con ella.')
    await assertRoom(client, i.org_id, 'people')

    const sso = await passwordRefused(client, { email: i.email, orgId: i.org_id, role: i.role })
    let passwordHash = null
    if (!sso) {
      const problem = passwordProblem(password)
      if (problem) throw new HttpError(400, 'bad_password', problem)
      passwordHash = await hashPassword(password)
    }
    const display = typeof name === 'string' && name.trim() ? name.trim().slice(0, 255) : i.email.split('@')[0]
    const { rows: [u] } = await client.query(
      `INSERT INTO users (org_id, team_id, email, name, role, password_hash)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [i.org_id, i.team_id, i.email, display, i.role, passwordHash])
    await client.query('UPDATE invitations SET accepted_at = now(), user_id = $2 WHERE id = $1', [i.id, u.id])
    await client.query('COMMIT')
    return { id: u.id, org_id: i.org_id, email: i.email, role: i.role, team_id: i.team_id, sso, invitationId: i.id }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

export const INVITATION_COLUMNS = `i.id, i.email, i.role, i.team_id, t.name AS team_name, i.invited_by,
  i.created_at, i.expires_at, (i.expires_at <= now()) AS expired`

/** The organization's open invitations (expired ones too, until replaced or revoked). */
export async function openInvitations(db, orgId, teamId = null) {
  const { rows } = await db.query(
    `SELECT ${INVITATION_COLUMNS}
       FROM invitations i LEFT JOIN teams t ON t.id = i.team_id
      WHERE i.org_id = $1 AND i.accepted_at IS NULL AND i.revoked_at IS NULL
        AND ($2::uuid IS NULL OR i.team_id = $2)
      ORDER BY i.created_at DESC`, [orgId, teamId])
  return rows
}
