/**
 * lib/history-audit.js — what an application that keeps people's
 * conversations (the chat portal) needs from the console so an Auditor can
 * read a person's history (/api/oidc/history-audit):
 *
 *   roles    whether the person signed in may audit (Auditor) or approve an
 *            audit someone else asked for (Auditor or Owner)
 *   people   the organization's people, to choose whose history
 *   subject  one of them, as the console knows them now
 *   record   a place in the audit log for each request, approval, refusal,
 *            revocation and reading
 *
 * The console decides who is who, every time; the application keeps the
 * requests and the conversations, which the console never sees. The
 * application has to be allowed to ask (oidc_clients.history_audit, 035).
 *
 * The rules the console holds no matter what the application does: only an
 * Auditor asks and reads; an Auditor or an Owner approves, refuses or
 * revokes; nobody asks for their own history, approves a request of their
 * own or one about themselves.
 */

import { audit } from './audit.js'

export const ACTIONS = {
  'history.request': ['auditor'],
  'history.approve': ['auditor', 'owner'],
  'history.deny':    ['auditor', 'owner'],
  'history.revoke':  ['auditor', 'owner'],
  'history.read':    ['auditor'],
}
export const AUDITS = ['auditor']
export const APPROVES = ['auditor', 'owner']

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/
const isUuid = (v) => typeof v === 'string' && UUID_RE.test(v)

export class AuditError extends Error {
  constructor(status, code, message) {
    super(message)
    this.status = status
    this.code = code
  }
}

/** The person signed in to the application: active, allowed to use applications, in its organization. */
async function actor(db, client, personId) {
  if (!isUuid(personId)) throw new AuditError(400, 'invalid_person', 'person tiene que ser el id de la persona.')
  const { rows: [u] } = await db.query(
    `SELECT u.id::text AS id, COALESCE(NULLIF(u.name, ''), u.email) AS name, u.email, u.role
       FROM users u JOIN organizations o ON o.id = u.org_id
      WHERE u.id = $1 AND u.org_id = $2 AND o.status = 'active'
        AND COALESCE(u.is_active, true) AND COALESCE(u.app_access, true)`,
    [personId, client.org_id])
  if (!u) throw new AuditError(404, 'unknown_user', 'La persona no existe o no puede usar aplicaciones.')
  return u
}

/**
 * Whose history: anyone of the organization, also someone no longer active
 * (a person who left is a usual case for an audit).
 */
async function subject(db, client, subjectId) {
  if (!isUuid(subjectId)) throw new AuditError(400, 'invalid_subject', 'subject tiene que ser el id de una persona.')
  const { rows: [u] } = await db.query(
    `SELECT u.id::text AS id, COALESCE(NULLIF(u.name, ''), u.email) AS name, u.email,
            COALESCE(u.is_active, true) AS active
       FROM users u WHERE u.id = $1 AND u.org_id = $2`,
    [subjectId, client.org_id])
  if (!u) throw new AuditError(404, 'unknown_subject', 'Esa persona no es de la organización.')
  return u
}

const publicPerson = (u) => ({ id: u.id, name: u.name, email: u.email })

/** { person, audit, approve }: what the person may do with histories now. */
export async function auditRoles(db, client, personId) {
  const u = await actor(db, client, personId)
  return { person: publicPerson(u), audit: AUDITS.includes(u.role), approve: APPROVES.includes(u.role) }
}

/** Up to 10 people whose name or email has `q`, for an Auditor choosing whose history. */
export async function findPeople(db, client, personId, q) {
  const u = await actor(db, client, personId)
  if (!AUDITS.includes(u.role)) throw new AuditError(403, 'not_auditor', 'Solo quien tiene el rol Auditor/a puede buscar personas.')
  const text = typeof q === 'string' ? q.trim().slice(0, 100) : ''
  if (text.length < 2) return []
  const like = `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`
  const { rows } = await db.query(
    `SELECT u.id::text AS id, COALESCE(NULLIF(u.name, ''), u.email) AS name, u.email,
            COALESCE(u.is_active, true) AS active
       FROM users u
      WHERE u.org_id = $1 AND u.id <> $2 AND (u.email ILIKE $3 OR u.name ILIKE $3)
      ORDER BY COALESCE(u.is_active, true) DESC, u.email
      LIMIT 10`,
    [client.org_id, u.id, like])
  return rows.map(r => ({ id: r.id, name: r.name, email: r.email, active: r.active }))
}

/** One person of the organization, for someone who audits or approves. */
export async function subjectFor(db, client, personId, subjectId) {
  const u = await actor(db, client, personId)
  if (!APPROVES.includes(u.role)) throw new AuditError(403, 'not_auditor', 'Solo Auditor/a u Owner.')
  const s = await subject(db, client, subjectId)
  return { id: s.id, name: s.name, email: s.email, active: s.active }
}

const clip = (v, n) => (typeof v === 'string' ? v.trim().slice(0, n) : undefined)

/** What an application may put in an entry's details, and nothing else. */
export function cleanDetails(d = {}) {
  const out = {}
  if (isUuid(d.request)) out.request = d.request.toLowerCase()
  if (isUuid(d.requester)) out.requester = d.requester.toLowerCase()
  if (isUuid(d.conversation)) out.conversation = d.conversation.toLowerCase()
  if (DATE_RE.test(d.from ?? '')) out.from = d.from
  if (DATE_RE.test(d.to ?? '')) out.to = d.to
  const reason = clip(d.reason, 1000)
  if (reason) out.reason = reason
  const note = clip(d.note, 500)
  if (note) out.note = note
  return out
}

/**
 * Records what someone did with a history through the application, after
 * checking they may. Refusals are recorded too (result 'denied').
 * Returns the entry's details.
 */
export async function recordAction(db, client, { person, action, subject: subjectId, details } = {}, req) {
  if (!Object.hasOwn(ACTIONS, action)) throw new AuditError(400, 'invalid_action', `action tiene que ser una de: ${Object.keys(ACTIONS).join(', ')}.`)
  const u = await actor(db, client, person)
  const s = await subject(db, client, subjectId)
  const d = cleanDetails(details)
  const entry = {
    app: client.name, subject_email: s.email, subject_name: s.name, ...d,
  }
  const write = (result, extra = {}) => audit(db, {
    req, session: { orgId: client.org_id, userId: u.id, email: u.email, role: u.role },
    action, result, targetType: 'user', targetId: s.id, details: { ...entry, ...extra },
  })
  const refuse = async (status, code, message) => {
    await write('denied', { refused: code })
    throw new AuditError(status, code, message)
  }

  if (!ACTIONS[action].includes(u.role)) {
    return refuse(403, 'not_allowed', action === 'history.request' || action === 'history.read'
      ? 'Solo quien tiene el rol Auditor/a puede pedir y leer historiales.'
      : 'Solo Auditor/a u Owner pueden decidir sobre un pedido.')
  }
  if (u.id === s.id) return refuse(403, 'own_history', 'Nadie audita ni decide sobre su propio historial.')
  if (action === 'history.request' && !(d.from && d.to && d.reason)) {
    throw new AuditError(400, 'invalid_details', 'Un pedido lleva from, to y reason.')
  }
  if (['history.approve', 'history.deny'].includes(action)) {
    if (!d.requester) throw new AuditError(400, 'invalid_details', 'Una decisión lleva requester.')
    if (d.requester === u.id) return refuse(403, 'own_request', 'Quien pidió no puede aprobar ni rechazar su propio pedido.')
  }
  if (action === 'history.read' && !d.request) throw new AuditError(400, 'invalid_details', 'Una lectura lleva request.')
  await write('ok')
  return entry
}
