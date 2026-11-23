// Invitations (ADR-0020, migration 049), against PostgreSQL: a link that
// works once, for 72 hours, where someone chooses their own password. From
// the console (Owner, Admin, team manager) and from outside the
// organization (platform API), for its first Owner.
//
//   DATABASE_URL=postgres://... node --import ./test/register.mjs --test test/
//
// Skipped without DATABASE_URL.

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID, randomBytes, createHash } from 'node:crypto'

process.env.STRATUM_ENCRYPTION_KEY ??= randomBytes(32).toString('hex')
delete process.env.STRATUM_SMTP_URL
delete process.env.STRATUM_CONSOLE_URL

const { NextRequest } = await import('next/server.js')
const pg = (await import('pg')).default
const { closeDb } = await import('../lib/db.js')
const { verifyPassword } = await import('../lib/password.js')
const { createPlatformToken } = await import('../lib/platform.js')
const { sendInvitation, invitationMessage } = await import('../lib/invitations.js')

const url = process.env.DATABASE_URL
const skip = url ? false : 'DATABASE_URL not set'
const PASSWORD = 'correct horse battery'
let db, PLATFORM
const orgs = []

const mods = {}
async function call(path, method, { as, bearer, body, params = {} } = {}) {
  mods[path] ??= await import(`../app/api/${path}/route.js`)
  const headers = {}
  if (as) headers.cookie = `stratum_session=${as}`
  if (bearer) headers.authorization = `Bearer ${bearer}`
  if (body !== undefined) headers['content-type'] = 'application/json'
  const req = new NextRequest(`https://consola.test/api/${path}`, {
    method, headers, body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const res = await mods[path][method](req, { params: Promise.resolve(params) })
  const text = await res.text()
  return { status: res.status, body: text ? JSON.parse(text) : null, cookie: res.cookies.get('stratum_session')?.value }
}

const sql = async (text, params = []) => (await db.query(text, params)).rows
const tokenOf = (link) => link.split('#')[1]
const email = (who, o) => `${who}-${o.id.slice(0, 8)}@example.com`

async function session(userEmail) {
  const token = randomBytes(32).toString('hex')
  await sql(`INSERT INTO console_sessions (token_hash, user_id, org_id, expires_at, enrollment_only)
             SELECT $1, u.id, u.org_id, now() + interval '1 hour', false FROM users u WHERE u.email = $2`,
    [createHash('sha256').update(token).digest('hex'), userEmail])
  return token
}

// An organization with an Owner and an Auditor signed in.
async function org(limits = {}) {
  const id = randomUUID()
  orgs.push(id)
  await sql('INSERT INTO organizations (id, name, limits) VALUES ($1, $2, $3)', [id, `inv-${id.slice(0, 8)}`, limits])
  const o = { id }
  for (const role of ['owner', 'auditor']) {
    await sql(`INSERT INTO users (org_id, email, role) VALUES ($1, $2, $3)`, [id, email(role, o), role])
    o[role] = await session(email(role, o))
  }
  return o
}

before(async () => {
  if (!url) return
  db = new pg.Pool({ connectionString: url, max: 4 })
  PLATFORM = (await createPlatformToken(db, { name: 'invitations test', days: 1 })).raw
})
after(async () => {
  if (!db) return
  await sql('DELETE FROM organizations WHERE id = ANY($1::uuid[])', [orgs])
  await db.end()
  await closeDb()
})

test('invitations: an Owner invites; the link works once and its person chooses the password', { skip }, async () => {
  const A = await org()
  const who = email('ana', A)
  const r = await call('invitations', 'POST', { as: A.owner, body: { email: who.toUpperCase(), role: 'member' } })
  assert.equal(r.status, 201)
  assert.equal(r.body.invitation.email, who)
  // Without SMTP it is not sent, and the link is in the answer; the token
  // goes in the fragment, which no server sees.
  assert.deepEqual([r.body.sent, r.body.reason], [false, 'no_smtp'])
  assert.match(r.body.link, /^https:\/\/consola\.test\/invite#stinv_[A-Za-z0-9_-]{43}$/)
  const token = tokenOf(r.body.link)
  const [row] = await sql('SELECT token_hash FROM invitations WHERE id = $1', [r.body.invitation.id])
  assert.notEqual(row.token_hash, token)

  assert.equal((await call('invitations', 'GET', { as: A.auditor })).body.length, 1)
  assert.equal((await call('invitations', 'POST', { as: A.auditor, body: { email: 'x@example.com' } })).status, 403)

  const look = await call('invitations/lookup', 'POST', { body: { token } })
  assert.equal(look.status, 200)
  assert.deepEqual([look.body.email, look.body.role, look.body.sso], [who, 'member', false])
  assert.equal((await call('invitations/lookup', 'POST', { body: { token: 'stinv_nope' } })).status, 410)

  // A short password is refused, and the link still works.
  assert.equal((await call('invitations/accept', 'POST', { body: { token, password: 'short' } })).status, 400)
  const ok = await call('invitations/accept', 'POST', { body: { token, name: 'Ana', password: PASSWORD } })
  assert.equal(ok.status, 200)
  // A member uses applications, not the console: no session.
  assert.deepEqual([ok.body.next, ok.body.console, ok.cookie], [null, false, undefined])
  const [u] = await sql('SELECT name, role, password_hash FROM users WHERE email = $1', [who])
  assert.deepEqual([u.name, u.role], ['Ana', 'member'])
  assert.ok(await verifyPassword(PASSWORD, u.password_hash))

  // Once.
  assert.equal((await call('invitations/accept', 'POST', { body: { token, password: PASSWORD } })).status, 410)
  assert.equal((await call('invitations', 'GET', { as: A.owner })).body.length, 0)
  const actions = (await sql(`SELECT action FROM audit_log WHERE org_id = $1 AND action LIKE 'invitation.%' ORDER BY id`, [A.id])).map(e => e.action)
  assert.deepEqual(actions, ['invitation.create', 'invitation.accept'])
  // Inviting someone who has an account is refused.
  assert.equal((await call('invitations', 'POST', { as: A.owner, body: { email: who } })).status, 409)
})

test('invitations: an Admin comes in to set up the second factor first', { skip }, async () => {
  const A = await org()
  const r = await call('invitations', 'POST', { as: A.owner, body: { email: email('admin', A), role: 'admin' } })
  const ok = await call('invitations/accept', 'POST', { body: { token: tokenOf(r.body.link), password: PASSWORD } })
  assert.equal(ok.body.next, '/account?mfa=required')
  assert.ok(ok.cookie)
  const [s] = await sql('SELECT enrollment_only FROM console_sessions WHERE token_hash = $1',
    [createHash('sha256').update(ok.cookie).digest('hex')])
  assert.equal(s.enrollment_only, true)
})

test('invitations: replaced, revoked, expired or suspended, the link stops', { skip }, async () => {
  const A = await org()
  const who = email('beto', A)
  const first = await call('invitations', 'POST', { as: A.owner, body: { email: who } })
  const second = await call('invitations', 'POST', { as: A.owner, body: { email: who } })
  assert.equal((await call('invitations/lookup', 'POST', { body: { token: tokenOf(first.body.link) } })).status, 410)
  assert.equal((await call('invitations/lookup', 'POST', { body: { token: tokenOf(second.body.link) } })).status, 200)

  assert.equal((await call('invitations/[id]', 'DELETE', { as: A.owner, params: { id: second.body.invitation.id } })).status, 200)
  assert.equal((await call('invitations/accept', 'POST', { body: { token: tokenOf(second.body.link), password: PASSWORD } })).status, 410)
  assert.equal((await call('invitations/[id]', 'DELETE', { as: A.owner, params: { id: second.body.invitation.id } })).status, 404)

  const third = await call('invitations', 'POST', { as: A.owner, body: { email: who } })
  await sql(`UPDATE invitations SET expires_at = now() - interval '1 s' WHERE id = $1`, [third.body.invitation.id])
  assert.equal((await call('invitations/accept', 'POST', { body: { token: tokenOf(third.body.link), password: PASSWORD } })).status, 410)
  assert.equal((await call('invitations', 'GET', { as: A.owner })).body[0].expired, true)

  const fourth = await call('invitations', 'POST', { as: A.owner, body: { email: who } })
  await sql(`UPDATE organizations SET status = 'suspended' WHERE id = $1`, [A.id])
  assert.equal((await call('invitations/accept', 'POST', { body: { token: tokenOf(fourth.body.link), password: PASSWORD } })).status, 410)
  assert.equal((await sql('SELECT count(*)::int AS n FROM users WHERE email = $1', [who]))[0].n, 0)
})

test('invitations: the plan\'s people count when it is accepted', { skip }, async () => {
  const A = await org({ people: 3 }) // the Owner and the Auditor already
  const one = await call('invitations', 'POST', { as: A.owner, body: { email: email('c1', A) } })
  const two = await call('invitations', 'POST', { as: A.owner, body: { email: email('c2', A) } })
  assert.equal((await call('invitations/accept', 'POST', { body: { token: tokenOf(one.body.link), password: PASSWORD } })).status, 200)
  const over = await call('invitations/accept', 'POST', { body: { token: tokenOf(two.body.link), password: PASSWORD } })
  assert.equal(over.status, 409)
  assert.equal(over.body.error, 'plan_limit')
  // Still open: it works once there is room.
  assert.equal((await call('invitations/lookup', 'POST', { body: { token: tokenOf(two.body.link) } })).status, 200)
})

test('invitations: an organization that signs in with SSO takes no password', { skip }, async () => {
  const A = await org()
  const domain = `sso-${A.id.slice(0, 8)}.test`
  await sql(`INSERT INTO sso_providers (org_id, kind, issuer, client_id, client_secret_encrypted, domains, enforce)
             VALUES ($1, 'oidc', 'https://idp.test', 'c', 'x', $2, true)`, [A.id, [domain]])
  const r = await call('invitations', 'POST', { as: A.owner, body: { email: `carla@${domain}`, role: 'auditor' } })
  const token = tokenOf(r.body.link)
  assert.equal((await call('invitations/lookup', 'POST', { body: { token } })).body.sso, true)
  const ok = await call('invitations/accept', 'POST', { body: { token, password: 'ignored' } })
  assert.deepEqual([ok.status, ok.body.sso, ok.body.next, ok.cookie], [200, true, '/login', undefined])
  assert.equal((await sql('SELECT password_hash FROM users WHERE email = $1', [`carla@${domain}`]))[0].password_hash, null)
})

test('invitations: the first Owner, from the platform API', { skip }, async () => {
  const id = randomUUID()
  orgs.push(id)
  await sql('INSERT INTO organizations (id, name) VALUES ($1, $2)', [id, `plat-${id.slice(0, 8)}`])
  const who = `owner-${id.slice(0, 8)}@example.com`
  const path = 'platform/organizations/[id]/invitations'

  assert.equal((await call(path, 'POST', { params: { id }, body: { email: who } })).status, 401)
  const r = await call(path, 'POST', { bearer: PLATFORM, params: { id }, body: { email: who } })
  assert.equal(r.status, 201)
  // Not sent (no SMTP): the link comes back, to pass on another way.
  assert.equal(r.body.sent, false)
  assert.ok(r.body.link)
  assert.equal((await call(path, 'GET', { bearer: PLATFORM, params: { id } })).body.invitations.length, 1)
  const bad = await call(path, 'POST', { bearer: PLATFORM, params: { id }, body: { email: 'nope' } })
  assert.deepEqual([bad.status, bad.body.message], [400, 'email is not a valid address.'])

  const ok = await call('invitations/accept', 'POST', { body: { token: tokenOf(r.body.link), password: PASSWORD } })
  assert.equal(ok.body.next, '/account?mfa=required')
  assert.equal((await sql('SELECT role FROM users WHERE email = $1', [who]))[0].role, 'owner')
  const taken = await call(path, 'POST', { bearer: PLATFORM, params: { id }, body: { email: who } })
  assert.deepEqual([taken.status, taken.body.error], [409, 'email_taken'])
  const pa = await sql(`SELECT actor FROM platform_audit WHERE org_id = $1 AND action = 'org.invite'`, [id])
  assert.equal(pa[0].actor, 'platform:invitations test')
})

test('invitations: the email carries the link, through the console\'s SMTP', async () => {
  const sent = []
  const transport = { sendMail: async (m) => { sent.push(m) } }
  const inv = { email: 'ana@example.com', role: 'owner', orgName: 'Acme', expiresAt: new Date('2026-12-01T12:00:00Z') }
  const r = await sendInvitation(inv, 'https://c.test/invite#stinv_x', { cfg: { smtpUrl: 'smtp://h', from: 'a@h' }, deps: { transport } })
  assert.deepEqual(r, { sent: true })
  assert.equal(sent[0].to, 'ana@example.com')
  assert.equal(sent[0].subject, 'Te invitaron a Acme en Stratum')
  assert.match(sent[0].text, /https:\/\/c\.test\/invite#stinv_x/)
  assert.match(sent[0].text, /2026-12-01 12:00/)
  const failing = { sendMail: async () => { throw new Error('boom') } }
  assert.equal((await sendInvitation(inv, 'l', { cfg: { smtpUrl: 'smtp://h' }, deps: { transport: failing } })).sent, false)
  assert.match(invitationMessage({ ...inv, link: 'l' }).text, /como Owner/)
})
