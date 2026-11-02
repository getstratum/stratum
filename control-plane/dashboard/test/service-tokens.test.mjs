// Service tokens: the console's API for automation (lib/service-tokens.js),
// through the real route handlers, against PostgreSQL.
//
//   DATABASE_URL=postgres://... node --import ./test/register.mjs --test test/
//
// Skipped without DATABASE_URL.

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID, createHash } from 'node:crypto'

const { NextRequest } = await import('next/server.js')
const pg = (await import('pg')).default
const { hashPassword } = await import('../lib/password.js')
const { closeDb } = await import('../lib/db.js')
const { parseNewToken, bearerToken, SCOPES } = await import('../lib/service-tokens.js')

const url = process.env.DATABASE_URL
const skip = url ? false : 'DATABASE_URL not set'
const PASSWORD = 'correct horse battery'
let db
const orgs = []
const sql = async (text, params = []) => (await db.query(text, params)).rows

const mods = {}
async function call(path, method, { as, token, body, params = {} } = {}) {
  mods[path] ??= await import(`../app/api/${path}/route.js`)
  const headers = {}
  if (as) headers.cookie = `stratum_session=${as}`
  if (token) headers.authorization = `Bearer ${token}`
  if (body !== undefined) headers['content-type'] = 'application/json'
  const req = new NextRequest(`http://console.test/api/${path}`, {
    method, headers, body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const res = await mods[path][method](req, { params: Promise.resolve(params) })
  const text = await res.text()
  return { status: res.status, body: text ? JSON.parse(text) : null, res }
}

async function org() {
  const id = randomUUID()
  orgs.push(id)
  await sql('INSERT INTO organizations (id, name) VALUES ($1, $2)', [id, `s-${id.slice(0, 8)}`])
  const [team] = await sql(`INSERT INTO teams (org_id, name) VALUES ($1, 'Ingeniería') RETURNING id`, [id])
  const hash = await hashPassword(PASSWORD)
  const out = { id, team: team.id }
  for (const role of ['owner', 'admin']) {
    const email = `${role}-${id.slice(0, 8)}@example.com`
    const [u] = await sql(`INSERT INTO users (org_id, team_id, email, role, password_hash) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [id, team.id, email, role, hash])
    out[`${role}Id`] = u.id
    const r = await call('session', 'POST', { body: { email, password: PASSWORD } })
    const cookie = r.res.cookies.get('stratum_session').value
    await sql('UPDATE console_sessions SET enrollment_only = false WHERE token_hash = $1',
      [createHash('sha256').update(cookie).digest('hex')])
    out[role] = cookie
  }
  return out
}

let A, B

before(async () => {
  if (!url) return
  db = new pg.Pool({ connectionString: url, max: 2 })
  A = await org()
  B = await org()
})

after(async () => {
  if (!db) return
  await sql('DELETE FROM organizations WHERE id = ANY($1::uuid[])', [orgs])
  await db.end()
  await closeDb()
})

test('a new token: a name, known permissions, at most a year', () => {
  assert.deepEqual(parseNewToken({ name: ' tf ', scopes: ['users.read', 'teams.read', 'users.read'], expiresInDays: 30 }),
    { name: 'tf', scopes: ['users.read', 'teams.read'], days: 30 })
  assert.equal(parseNewToken({ name: 'x', scopes: ['users.read'] }).days, 90)
  for (const bad of [
    { scopes: ['users.read'] }, { name: 'x', scopes: [] }, { name: 'x', scopes: ['providers.manage'] },
    { name: 'x', scopes: ['org.read'] }, { name: 'x', scopes: ['tokens.manage'] }, { name: 'x', scopes: ['users.read'], expiresInDays: 400 },
  ]) assert.throws(() => parseNewToken(bad), JSON.stringify(bad))
  assert.ok(!SCOPES.some(s => /providers\.manage|gateways\.manage|apps\.manage|sso\.manage|tokens\./.test(s)))
  const h = (v) => ({ headers: new Headers({ authorization: v }) })
  assert.equal(bearerToken(h('Bearer stsvc_abc')), 'stsvc_abc')
  assert.equal(bearerToken(h('Bearer aig_sk_abc')), null, 'other keys are not service tokens')
})

let token
test('only an Owner makes a token; it is shown once and kept as a hash', { skip }, async () => {
  const no = await call('service-tokens', 'POST', { as: A.admin, body: { name: 'scim', scopes: ['users.read'] } })
  assert.equal(no.status, 403)
  const r = await call('service-tokens', 'POST', { as: A.owner, body: { name: 'scim', scopes: ['users.read', 'users.manage', 'teams.read'], expiresInDays: 30 } })
  assert.equal(r.status, 201, JSON.stringify(r.body))
  token = r.body.value
  assert.match(token, /^stsvc_/)
  const [row] = await sql('SELECT token_hash, created_by::text AS by FROM service_tokens WHERE id = $1', [r.body.token.id])
  assert.equal(row.token_hash, createHash('sha256').update(token).digest('hex'))
  assert.equal(row.by, A.ownerId)
  const list = await call('service-tokens', 'GET', { as: A.admin })
  assert.equal(list.status, 200)
  assert.ok(!JSON.stringify(list.body).includes(token))
  assert.deepEqual(list.body.tokens[0].scopes, ['users.read', 'users.manage', 'teams.read'])
})

test('a token reaches what its permissions allow, in its organization, recorded by name', { skip }, async () => {
  const users = await call('users', 'GET', { token })
  assert.equal(users.status, 200)
  assert.ok(users.body.every(u => u.email.endsWith(`${A.id.slice(0, 8)}@example.com`)), 'only its organization')
  // A permission it does not have.
  assert.equal((await call('internal/providers', 'GET', { token })).status, 403)
  const [denied] = await sql(`SELECT actor_label, result FROM audit_log WHERE org_id = $1 AND action = 'permission.denied' ORDER BY id DESC LIMIT 1`, [A.id])
  assert.deepEqual(denied, { actor_label: 'token:scim', result: 'denied' })

  // Provisioning someone who signs in with SSO: no password, no key needed.
  const made = await call('users', 'POST', { token, body: { email: `ana-${A.id.slice(0, 8)}@example.com`, name: 'Ana', role: 'auditor', teamId: A.team } })
  assert.equal(made.status, 201, JSON.stringify(made.body))
  const [entry] = await sql(`SELECT actor_label, actor_role FROM audit_log WHERE org_id = $1 AND action = 'user.create' ORDER BY id DESC LIMIT 1`, [A.id])
  assert.deepEqual(entry, { actor_label: 'token:scim', actor_role: 'service' })
  const ana = made.body.user.id
  assert.equal((await call('users/[id]', 'PATCH', { token, params: { id: ana }, body: { isActive: false } })).status, 200)
})

test('a token is never a person: no Owners, passwords, personal keys, MFA resets or tokens', { skip }, async () => {
  const email = (n) => `${n}-${A.id.slice(0, 8)}@example.com`
  assert.equal((await call('users', 'POST', { token, body: { email: email('o'), role: 'owner' } })).status, 403)
  assert.equal((await call('users', 'POST', { token, body: { email: email('p'), password: PASSWORD } })).status, 403)
  assert.equal((await call('users', 'POST', { token, body: { email: email('k'), giveApiKey: true } })).status, 403)
  assert.equal((await call('users/[id]', 'PATCH', { token, params: { id: A.ownerId }, body: { name: 'x' } })).status, 403, 'not an Owner')
  assert.equal((await call('users/[id]', 'PATCH', { token, params: { id: A.adminId }, body: { newPassword: 'otra contraseña larga' } })).status, 403)
  assert.equal((await call('users/[id]/mfa', 'DELETE', { token, params: { id: A.adminId } })).status, 403)
  assert.equal((await call('service-tokens', 'POST', { token, body: { name: 'x', scopes: ['users.read'] } })).status, 403)
  assert.equal((await call('service-tokens', 'GET', { token })).status, 403)
  assert.equal((await call('session', 'GET', { token })).status, 403, 'the session routes are not for tokens')
})

test('another organization, a revoked or an expired token: nothing', { skip }, async () => {
  const other = await call('users/[id]', 'PATCH', { token, params: { id: B.adminId }, body: { name: 'x' } })
  assert.equal(other.status, 404)
  const [{ id }] = await sql(`SELECT id FROM service_tokens WHERE org_id = $1`, [A.id])
  assert.equal((await call('service-tokens/[id]', 'DELETE', { as: B.owner, params: { id } })).status, 404)
  assert.equal((await call('service-tokens/[id]', 'DELETE', { as: A.owner, params: { id } })).status, 200)
  assert.equal((await call('users', 'GET', { token })).status, 401)

  const fresh = await call('service-tokens', 'POST', { as: A.owner, body: { name: 'old', scopes: ['users.read'], expiresInDays: 1 } })
  await sql(`UPDATE service_tokens SET expires_at = now() - interval '1 second' WHERE id = $1`, [fresh.body.token.id])
  assert.equal((await call('users', 'GET', { token: fresh.body.value })).status, 401)
  assert.equal((await call('users', 'GET', { token: 'stsvc_nope' })).status, 401)
})
