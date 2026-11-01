// Auditing a person's history through an application (lib/history-audit.js).
//
//   DATABASE_URL=postgres://... node --import ./test/register.mjs --test test/
//
// Skipped without DATABASE_URL.

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

const pg = (await import('pg')).default
const { auditRoles, findPeople, subjectFor, recordAction, cleanDetails, AuditError } = await import('../lib/history-audit.js')

const url = process.env.DATABASE_URL
const skip = url ? false : 'DATABASE_URL not set'
let db
const orgs = []
const sql = async (text, params = []) => (await db.query(text, params)).rows
let O, client, other

async function person(org, team, name, role = 'member', { active = true, apps = true } = {}) {
  const [u] = await sql(`INSERT INTO users (org_id, team_id, email, name, role, is_active, app_access)
                         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
  [org, team, `${name.toLowerCase()}-${org.slice(0, 8)}@example.com`, name, role, active, apps])
  return u.id
}

async function org(name) {
  const id = randomUUID()
  orgs.push(id)
  await sql('INSERT INTO organizations (id, name) VALUES ($1, $2)', [id, `${name}-${id.slice(0, 8)}`])
  const [t] = await sql(`INSERT INTO teams (org_id, name) VALUES ($1, 'Ingeniería') RETURNING id`, [id])
  return { id, team: t.id }
}

const lastEntry = async (orgId) => (await sql(
  `SELECT action, result, actor_user_id::text AS actor, actor_role, target_id, details
     FROM audit_log WHERE org_id = $1 ORDER BY id DESC LIMIT 1`, [orgId]))[0]

const rejects = (p, code) => assert.rejects(p, (e) => e instanceof AuditError && e.code === code)

before(async () => {
  if (!url) return
  db = new pg.Pool({ connectionString: url, max: 2 })
  O = await org('h')
  O.aud = await person(O.id, O.team, 'Auditora', 'auditor')
  O.aud2 = await person(O.id, O.team, 'Segunda', 'auditor')
  O.owner = await person(O.id, O.team, 'Dueña', 'owner')
  O.admin = await person(O.id, O.team, 'Admin', 'admin')
  O.ana = await person(O.id, O.team, 'Ana')
  O.gone = await person(O.id, O.team, 'Ida', 'member', { active: false })
  O.noapps = await person(O.id, O.team, 'Sinapps', 'auditor', { apps: false })
  client = { id: 'app_test', org_id: O.id, name: 'Portal', history_audit: true }
  const X = await org('x')
  X.bob = await person(X.id, X.team, 'Bob')
  other = X
})

after(async () => {
  if (!db) return
  // audit_log is append-only: its entries of these organizations stay.
  await sql('DELETE FROM organizations WHERE id = ANY($1::uuid[])', [orgs])
  await db.end()
})

test('roles: only an Auditor audits; an Auditor or an Owner approves', { skip }, async () => {
  assert.deepEqual(await auditRoles(db, client, O.aud).then(r => [r.audit, r.approve]), [true, true])
  assert.deepEqual(await auditRoles(db, client, O.owner).then(r => [r.audit, r.approve]), [false, true])
  assert.deepEqual(await auditRoles(db, client, O.admin).then(r => [r.audit, r.approve]), [false, false])
  assert.deepEqual(await auditRoles(db, client, O.ana).then(r => [r.audit, r.approve]), [false, false])
  const r = await auditRoles(db, client, O.aud)
  assert.equal(r.person.name, 'Auditora')
  assert.equal(r.person.role, undefined, 'the role itself is not given')
})

test('roles: someone inactive, without applications or from another organization is unknown', { skip }, async () => {
  await rejects(auditRoles(db, client, O.gone), 'unknown_user')
  await rejects(auditRoles(db, client, O.noapps), 'unknown_user')
  await rejects(auditRoles(db, client, other.bob), 'unknown_user')
  await rejects(auditRoles(db, client, 'not-a-uuid'), 'invalid_person')
})

test('people: only for an Auditor, never themselves, people who left included', { skip }, async () => {
  await rejects(findPeople(db, client, O.owner, 'ana'), 'not_auditor')
  const found = await findPeople(db, client, O.aud, 'ana')
  assert.deepEqual(found.map(p => p.name), ['Ana'])
  assert.deepEqual(await findPeople(db, client, O.aud, 'a'), [], 'two characters at least')
  const all = await findPeople(db, client, O.aud, 'example.com')
  assert.ok(!all.some(p => p.id === O.aud), 'not the Auditor')
  assert.ok(all.some(p => p.id === O.gone && p.active === false), 'someone who left can be audited')
  assert.ok(!all.some(p => p.id === other.bob), 'only the organization')
  assert.deepEqual(await findPeople(db, client, O.aud, '%'), [], 'a % matches itself, not everyone')
})

test('subject: an Auditor or an Owner, someone of the organization', { skip }, async () => {
  assert.equal((await subjectFor(db, client, O.owner, O.ana)).name, 'Ana')
  await rejects(subjectFor(db, client, O.admin, O.ana), 'not_auditor')
  await rejects(subjectFor(db, client, O.aud, other.bob), 'unknown_subject')
})

const REQ = randomUUID()
const request = { from: '2026-10-01', to: '2026-10-15', reason: 'Denuncia de filtración de datos de clientes, caso 1432.' }

test('record: a request by an Auditor is in the audit log, as theirs, about the person', { skip }, async () => {
  await recordAction(db, client, { person: O.aud, action: 'history.request', subject: O.ana, details: { ...request, request: REQ, extra: 'ignored' } })
  const e = await lastEntry(O.id)
  assert.equal(e.action, 'history.request')
  assert.equal(e.result, 'ok')
  assert.equal(e.actor, O.aud)
  assert.equal(e.actor_role, 'auditor')
  assert.equal(e.target_id, O.ana)
  assert.equal(e.details.app, 'Portal')
  assert.equal(e.details.subject_email, `ana-${O.id.slice(0, 8)}@example.com`)
  assert.equal(e.details.reason, request.reason)
  assert.equal(e.details.from, '2026-10-01')
  assert.equal(e.details.extra, undefined)
})

test('record: what the console refuses, whatever the application says', { skip }, async () => {
  await rejects(recordAction(db, client, { person: O.owner, action: 'history.request', subject: O.ana, details: request }), 'not_allowed')
  assert.equal((await lastEntry(O.id)).result, 'denied', 'a refusal is recorded too')
  await rejects(recordAction(db, client, { person: O.admin, action: 'history.approve', subject: O.ana, details: { requester: O.aud } }), 'not_allowed')
  await rejects(recordAction(db, client, { person: O.aud, action: 'history.request', subject: O.aud, details: request }), 'own_history')
  await rejects(recordAction(db, client, { person: O.aud, action: 'history.approve', subject: O.ana, details: { requester: O.aud, request: REQ } }), 'own_request')
  await rejects(recordAction(db, client, { person: O.owner, action: 'history.read', subject: O.ana, details: { request: REQ } }), 'not_allowed')
  await rejects(recordAction(db, client, { person: O.aud, action: 'history.request', subject: O.ana, details: { from: '2026-10-01' } }), 'invalid_details')
  await rejects(recordAction(db, client, { person: O.aud2, action: 'history.approve', subject: O.ana, details: {} }), 'invalid_details')
  await rejects(recordAction(db, client, { person: O.aud, action: 'history.delete', subject: O.ana }), 'invalid_action')
  await rejects(recordAction(db, client, { person: O.aud, action: 'history.read', subject: other.bob, details: { request: REQ } }), 'unknown_subject')
})

test('record: a second Auditor or an Owner approves; the first reads', { skip }, async () => {
  await recordAction(db, client, { person: O.aud2, action: 'history.approve', subject: O.ana, details: { requester: O.aud, request: REQ, note: 'Ok, caso abierto.' } })
  assert.equal((await lastEntry(O.id)).details.note, 'Ok, caso abierto.')
  await recordAction(db, client, { person: O.owner, action: 'history.deny', subject: O.ana, details: { requester: O.aud, request: REQ } })
  assert.equal((await lastEntry(O.id)).actor_role, 'owner')
  const conversation = randomUUID()
  await recordAction(db, client, { person: O.aud, action: 'history.read', subject: O.ana, details: { request: REQ, conversation } })
  const e = await lastEntry(O.id)
  assert.equal(e.action, 'history.read')
  assert.equal(e.details.conversation, conversation)
})

test('details: only what has a known shape is kept', () => {
  const d = cleanDetails({ request: 'x', from: '2026-13-01', to: '2026-10-31', reason: '  r  ', note: 'n'.repeat(900), other: 1 })
  assert.deepEqual(Object.keys(d).sort(), ['note', 'reason', 'to'])
  assert.equal(d.reason, 'r')
  assert.equal(d.note.length, 500)
})
