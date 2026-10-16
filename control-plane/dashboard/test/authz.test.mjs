// Console access control against a real PostgreSQL with every migration
// applied: sign-in, sessions, roles, team scope and isolation between
// organizations. Calls the route handlers directly, as Next.js would.
//
//   DATABASE_URL=postgres://... node --import ./test/register.mjs --test test/
//
// Skipped without DATABASE_URL. Each run works in two organizations of its own.

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { NextRequest } from 'next/server.js'
import pg from 'pg'
import { hashPassword } from '../lib/password.js'
import { closeDb } from '../lib/db.js'

const url = process.env.DATABASE_URL
const skip = url ? false : 'DATABASE_URL not set'
let db
const orgs = []
const PASSWORD = 'correct horse battery'

// --- calling handlers ---------------------------------------------------------

const mod = {}
async function api(path) {
  if (!mod[path]) mod[path] = await import(`../app/api/${path}/route.js`)
  return mod[path]
}

/**
 * call('users/[id]', 'PATCH', { as: cookie, params: { id }, body, query, headers })
 * → { status, body, res }
 */
async function call(path, method, { as, params = {}, body, query = '', headers = {} } = {}) {
  const m = await api(path)
  const h = { ...headers }
  if (as) h.cookie = `stratum_session=${as}`
  if (body !== undefined) h['content-type'] = 'application/json'
  const req = new NextRequest(`http://console.test/api/${path}${query}`, {
    method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const res = await m[method](req, { params: Promise.resolve(params) })
  const text = await res.text()
  return { status: res.status, body: text ? JSON.parse(text) : null, res }
}

// Owners and Admins must set up a second factor before anything else
// (test/mfa.test.mjs covers that); here their sessions count as if they had.
async function login(email, password = PASSWORD) {
  const r = await call('session', 'POST', { body: { email, password } })
  const cookie = r.res.cookies.get('stratum_session')?.value
  if (cookie && r.body?.mfa_enrollment_required) await skipEnrollment(cookie)
  return { ...r, cookie }
}

async function skipEnrollment(cookie) {
  await db.query('UPDATE console_sessions SET enrollment_only = false WHERE token_hash = $1',
    [createHash('sha256').update(cookie).digest('hex')])
}

// --- fixture -------------------------------------------------------------------

const sql = async (text, params = []) => (await db.query(text, params)).rows

async function org(tag) {
  const id = randomUUID()
  orgs.push(id)
  await sql('INSERT INTO organizations (id, name) VALUES ($1, $2)', [id, `${tag}-${id.slice(0, 8)}`])
  const [policy] = await sql(`INSERT INTO policies (org_id, name) VALUES ($1, 'base') RETURNING id`, [id])
  const team = async (name) => (await sql(
    'INSERT INTO teams (org_id, name, policy_id) VALUES ($1, $2, $3) RETURNING id', [id, name, policy.id]))[0].id
  const t1 = await team('one')
  const t2 = await team('two')
  const hash = await hashPassword(PASSWORD)
  const users = {}
  for (const [role, teamId] of [['owner', null], ['admin', null], ['team_manager', t1], ['auditor', null], ['member', t1], ['member2', t2]]) {
    const email = `${role}-${id.slice(0, 8)}@example.com`
    const [u] = await sql(
      `INSERT INTO users (org_id, team_id, email, name, role, password_hash, api_key_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [id, teamId, email, role, role === 'member2' ? 'member' : role, hash, randomUUID().replaceAll('-', '')])
    users[role] = { id: u.id, email }
  }
  const [agent] = await sql(`INSERT INTO agents (org_id, team_id, name) VALUES ($1, $2, 'bot') RETURNING id`, [id, t2])
  const [alert] = await sql(
    `INSERT INTO alerts (org_id, team_id, alert_type, destination) VALUES ($1, $2, 'budget', 'a@example.com') RETURNING id`, [id, t2])
  await sql(`INSERT INTO data_plane_instances (id, org_id, name, sync_token_hash) VALUES ($1, $2, 'gw', $3)`,
    [`dp_${id.replaceAll('-', '')}`, id, randomUUID()])
  await sql(`INSERT INTO request_logs (org_id, team_id, user_id, provider, model_id, cost_usd)
             VALUES ($1, $2, $3, 'anthropic', 'm', 1), ($1, $4, $5, 'anthropic', 'm', 2)`,
    [id, t1, users.member.id, t2, users.member2.id])
  return { id, policy: policy.id, t1, t2, users, agent: agent.id, alert: alert.id, instance: `dp_${id.replaceAll('-', '')}` }
}

let A, B
const S = {} // cookies by role, organization A
let bOwner

before(async () => {
  if (!url) return
  db = new pg.Pool({ connectionString: url, max: 3 })
  A = await org('a')
  B = await org('b')
  for (const role of ['owner', 'admin', 'team_manager', 'auditor']) {
    const r = await login(A.users[role].email)
    assert.equal(r.status, 200, `${role} signs in`)
    S[role] = r.cookie
  }
  bOwner = (await login(B.users.owner.email)).cookie
})

after(async () => {
  if (!db) return
  // alerts.org_id has no ON DELETE CASCADE (001_schema.sql).
  await sql('DELETE FROM alerts WHERE org_id = ANY($1::uuid[])', [orgs])
  await sql('DELETE FROM organizations WHERE id = ANY($1::uuid[])', [orgs])
  await db.end()
  await closeDb()
})

// --- sign-in and sessions ----------------------------------------------------------

test('sign-in: wrong password, unknown email and members are refused', { skip }, async () => {
  assert.equal((await login(A.users.owner.email, 'wrong password!!')).status, 401)
  assert.equal((await login(`nobody-${randomUUID()}@example.com`)).status, 401)
  // A right password on an account that cannot sign in gets the same answer
  // as a wrong one.
  const member = await login(A.users.member.email)
  assert.equal(member.status, 401)
  assert.equal(member.cookie, undefined)
  // Emails are matched without regard to case.
  assert.equal((await login(A.users.auditor.email.toUpperCase())).status, 200)
})

test('ten failed attempts lock the account, even for the right password', { skip }, async () => {
  const [u] = await sql(
    `INSERT INTO users (org_id, email, role, password_hash) VALUES ($1, $2, 'admin', $3) RETURNING email`,
    [A.id, `lock-${randomUUID()}@example.com`, await hashPassword(PASSWORD)])
  for (let i = 0; i < 10; i++) assert.equal((await login(u.email, 'not the password')).status, 401)
  assert.equal((await login(u.email)).status, 401, 'locked')
  await sql('UPDATE users SET locked_until = now() - interval \'1 second\' WHERE email = $1', [u.email])
  assert.equal((await login(u.email)).status, 200, 'unlocked after the lock period')
})

test('no session, a forged cookie or an idle session get 401', { skip }, async () => {
  assert.equal((await call('users', 'GET')).status, 401)
  assert.equal((await call('users', 'GET', { as: 'x'.repeat(43) })).status, 401)
  const r = await login(A.users.admin.email)
  await sql(`UPDATE console_sessions SET last_seen_at = now() - interval '31 minutes'
              WHERE token_hash = encode(sha256($1::bytea), 'hex')`, [r.cookie])
  assert.equal((await call('users', 'GET', { as: r.cookie })).status, 401)
})

test('sign-out ends the session', { skip }, async () => {
  const r = await login(A.users.admin.email)
  assert.equal((await call('users', 'GET', { as: r.cookie })).status, 200)
  await call('session', 'DELETE', { as: r.cookie })
  assert.equal((await call('users', 'GET', { as: r.cookie })).status, 401)
})

test('GET /api/session tells the UI the role and its permissions', { skip }, async () => {
  const me = (await call('session', 'GET', { as: S.team_manager })).body
  assert.equal(me.user.role, 'team_manager')
  assert.equal(me.org.id, A.id)
  assert.equal(me.permissions['users.manage'], 'team')
  assert.equal(me.permissions['providers.read'], undefined)
})

test('cross-site requests are refused before anything else', { skip }, async () => {
  const r = await call('policies', 'POST', { as: S.owner, body: { name: 'x' }, headers: { origin: 'https://evil.example' } })
  assert.equal(r.status, 403)
  const same = await call('policies', 'POST', { as: S.owner, body: { name: 'same-origin' }, headers: { origin: 'http://console.test', host: 'console.test' } })
  assert.equal(same.status, 201)
})

// --- isolation between organizations ------------------------------------------------

test('lists only show the session organization', { skip }, async () => {
  const users = (await call('users', 'GET', { as: S.owner })).body
  assert.ok(users.length >= 6)
  assert.ok(users.every(u => !u.email.includes(B.id.slice(0, 8))))
  const teams = (await call('teams', 'GET', { as: S.owner })).body
  assert.deepEqual(new Set(teams.map(t => t.id)), new Set([A.t1, A.t2]))
  const logs = (await call('logs', 'GET', { as: S.owner })).body
  assert.equal(logs.length, 2)
  const stats = (await call('stats', 'GET', { as: S.owner })).body
  assert.equal(Number(stats.totals.total_requests), 2)
  const inst = (await call('internal/instances', 'GET', { as: S.owner })).body.instances
  assert.deepEqual(inst.map(i => i.id), [A.instance])
})

test("another organization's objects do not exist", { skip }, async () => {
  const as = S.owner
  const cases = [
    ['users/[id]', 'PATCH', { params: { id: B.users.member.id }, body: { name: 'x' } }],
    ['users/[id]', 'POST', { params: { id: B.users.member.id }, body: { action: 'rotate-key' } }],
    ['teams/[id]', 'PATCH', { params: { id: B.t1 }, body: { monthlyBudgetUsd: 1 } }],
    ['policies/[id]', 'PATCH', { params: { id: B.policy }, body: { name: 'x' } }],
    ['policies/[id]', 'DELETE', { params: { id: B.policy } }],
    ['agents/[id]', 'PATCH', { params: { id: B.agent }, body: { name: 'x' } }],
    ['agents/[id]', 'POST', { params: { id: B.agent }, body: { action: 'rotate-key' } }],
    ['alerts/[id]', 'PATCH', { params: { id: B.alert }, body: { isActive: false } }],
    ['alerts/[id]', 'DELETE', { params: { id: B.alert } }],
    ['internal/instances', 'DELETE', { query: `?id=${B.instance}` }],
  ]
  for (const [path, method, opts] of cases) {
    const r = await call(path, method, { as, ...opts })
    assert.equal(r.status, 404, `${method} ${path} on B: ${JSON.stringify(r.body)}`)
  }
  // References to B's objects are refused too.
  assert.equal((await call('users', 'POST', { as, body: { email: `x-${randomUUID()}@example.com`, teamId: B.t1, giveApiKey: true } })).status, 404)
  assert.equal((await call('teams/[id]', 'PATCH', { as, params: { id: A.t1 }, body: { policyId: B.policy } })).status, 404)
  assert.equal((await call('alerts', 'POST', { as, body: { teamId: B.t1, alertType: 'budget', channel: 'email', destination: 'a@b.co' } })).status, 404)
  // Nothing of B changed.
  const [bm] = await sql('SELECT name FROM users WHERE id = $1', [B.users.member.id])
  assert.equal(bm.name, 'member')
})

// --- roles ------------------------------------------------------------------------

test('responses never carry password or key hashes', { skip }, async () => {
  const r = await call('users/[id]', 'PATCH', { as: S.owner, params: { id: A.users.member.id }, body: { name: 'Member' } })
  assert.equal(r.status, 200)
  for (const k of ['password_hash', 'api_key_hash']) assert.ok(!(k in r.body), k)
  for (const u of (await call('users', 'GET', { as: S.owner })).body) {
    assert.ok(!('password_hash' in u) && !('api_key_hash' in u))
  }
})

test('a team manager only reaches their own team', { skip }, async () => {
  const as = S.team_manager
  const users = (await call('users', 'GET', { as })).body
  assert.deepEqual(new Set(users.map(u => u.team_id)), new Set([A.t1]))
  assert.equal((await call('users/[id]', 'PATCH', { as, params: { id: A.users.member2.id }, body: { name: 'x' } })).status, 404)
  assert.equal((await call('users', 'POST', { as, body: { email: `tm-${randomUUID()}@example.com`, role: 'admin', giveApiKey: true } })).status, 403)
  const created = await call('users', 'POST', { as, body: { email: `tm-${randomUUID()}@example.com`, giveApiKey: true } })
  assert.equal(created.status, 201)
  assert.equal(created.body.user.team_id, A.t1, 'lands in the manager\'s team')
  assert.equal((await call('teams/[id]', 'PATCH', { as, params: { id: A.t1 }, body: { monthlyBudgetUsd: 300 } })).status, 200)
  assert.equal((await call('teams/[id]', 'PATCH', { as, params: { id: A.t1 }, body: { name: 'renamed' } })).status, 403)
  assert.equal((await call('teams/[id]', 'PATCH', { as, params: { id: A.t2 }, body: { monthlyBudgetUsd: 1 } })).status, 403)
  assert.equal((await call('agents/[id]', 'POST', { as, params: { id: A.agent }, body: { action: 'rotate-key' } })).status, 404)
  const logs = (await call('logs', 'GET', { as })).body
  assert.equal(logs.length, 1, 'only the team\'s requests')
})

test('permissions a role lacks are refused and recorded', { skip }, async () => {
  const r = await call('internal/providers', 'GET', { as: S.team_manager })
  assert.equal(r.status, 403)
  assert.equal((await call('users', 'POST', { as: S.auditor, body: { email: 'z@z.zz', giveApiKey: true } })).status, 403)
  assert.equal((await call('policies', 'POST', { as: S.team_manager, body: { name: 'x' } })).status, 403)
  assert.equal((await call('audit', 'GET', { as: S.team_manager })).status, 403)
  const audit = (await call('audit', 'GET', { as: S.auditor, query: '?result=denied' })).body.entries
  assert.ok(audit.some(e => e.action === 'permission.denied' && e.details.permission === 'providers.read'))
  assert.ok(audit.every(e => e.result === 'denied'))
})

test('owners are protected: only owners change them, and one always remains', { skip }, async () => {
  const owner = A.users.owner.id
  assert.equal((await call('users/[id]', 'PATCH', { as: S.admin, params: { id: owner }, body: { name: 'x' } })).status, 403)
  assert.equal((await call('users/[id]', 'PATCH', { as: S.admin, params: { id: A.users.auditor.id }, body: { role: 'owner' } })).status, 403)
  assert.equal((await call('users/[id]', 'PATCH', { as: S.owner, params: { id: owner }, body: { role: 'admin' } })).status, 403, 'not your own role')
  assert.equal((await call('users/[id]', 'PATCH', { as: S.owner, params: { id: owner }, body: { isActive: false } })).status, 403, 'not yourself')
  // A second owner may demote the first, but not the last one.
  const second = await call('users', 'POST', { as: S.owner, body: { email: `o2-${randomUUID()}@example.com`, role: 'owner', password: PASSWORD } })
  assert.equal(second.status, 201)
  const o2 = (await login(second.body.user.email)).cookie
  assert.equal((await call('users/[id]', 'PATCH', { as: o2, params: { id: owner }, body: { role: 'admin' } })).status, 200)
  assert.equal((await call('users/[id]', 'PATCH', { as: o2, params: { id: owner }, body: { role: 'owner' } })).status, 200)
  // The demotion ended the first owner's sessions.
  assert.equal((await call('users', 'GET', { as: S.owner })).status, 401)
  S.owner = (await login(A.users.owner.email)).cookie
})

test('deactivating someone or changing their role ends their sessions at once', { skip }, async () => {
  const [u] = await sql(
    `INSERT INTO users (org_id, email, role, password_hash) VALUES ($1, $2, 'admin', $3) RETURNING id, email`,
    [A.id, `deact-${randomUUID()}@example.com`, await hashPassword(PASSWORD)])
  const c = (await login(u.email)).cookie
  assert.equal((await call('users', 'GET', { as: c })).status, 200)
  assert.equal((await call('users/[id]', 'PATCH', { as: S.owner, params: { id: u.id }, body: { isActive: false } })).status, 200)
  assert.equal((await call('users', 'GET', { as: c })).status, 401)
  assert.equal((await login(u.email)).status, 401, 'and cannot sign in again')
})

test('a suspended organization loses console access', { skip }, async () => {
  assert.equal((await call('users', 'GET', { as: bOwner })).status, 200)
  await sql(`UPDATE organizations SET status = 'suspended' WHERE id = $1`, [B.id])
  assert.equal((await call('users', 'GET', { as: bOwner })).status, 401)
  assert.equal((await login(B.users.owner.email)).status, 401)
  await sql(`UPDATE organizations SET status = 'active' WHERE id = $1`, [B.id])
})

test('changes are recorded in the audit log, without secrets', { skip }, async () => {
  const r = await call('users/[id]', 'POST', { as: S.admin, params: { id: A.users.member.id }, body: { action: 'rotate-key' } })
  assert.equal(r.status, 200)
  const entries = (await call('audit', 'GET', { as: S.auditor })).body.entries
  const e = entries.find(x => x.action === 'user.key.rotate' && x.target_id === A.users.member.id)
  assert.ok(e, 'rotation recorded')
  assert.equal(e.actor_role, 'admin')
  assert.ok(!JSON.stringify(entries).includes(r.body.apiKey), 'the key is not in the log')
  // Another organization's log is not visible.
  const bEntries = (await call('audit', 'GET', { as: bOwner })).body.entries
  assert.ok(bEntries.every(x => x.target_id !== A.users.member.id))
})

test('a burst of parallel attempts cannot get past the lockout', { skip }, async () => {
  const email = `burst-${randomUUID()}@example.com`
  await sql(`INSERT INTO users (org_id, email, role, password_hash) VALUES ($1, $2, 'admin', $3)`,
    [A.id, email, await hashPassword(PASSWORD)])
  const results = await Promise.all(Array.from({ length: 30 }, () => login(email, 'not the password')))
  assert.ok(results.every(r => r.status === 401))
  const [{ n }] = await sql(
    `SELECT count(*)::int AS n FROM audit_log WHERE actor_label = $1 AND details->>'reason' = 'bad_password'`, [email])
  assert.ok(n <= 10, `${n} passwords were checked; at most 10 may be`)
  assert.equal((await login(email)).status, 401, 'the right password is refused while locked')
})

test('two owners demoting each other at once leave one owner', { skip }, async () => {
  const o = await org('race')
  const [o2] = await sql(`INSERT INTO users (org_id, email, role, password_hash) VALUES ($1, $2, 'owner', $3) RETURNING id, email`,
    [o.id, `o2-${randomUUID()}@example.com`, await hashPassword(PASSWORD)])
  const c1 = (await login(o.users.owner.email)).cookie
  const c2 = (await login(o2.email)).cookie
  const [r1, r2] = await Promise.all([
    call('users/[id]', 'PATCH', { as: c1, params: { id: o2.id }, body: { role: 'admin' } }),
    call('users/[id]', 'PATCH', { as: c2, params: { id: o.users.owner.id }, body: { role: 'admin' } }),
  ])
  const [{ n }] = await sql(`SELECT count(*)::int AS n FROM users WHERE org_id = $1 AND role = 'owner'`, [o.id])
  assert.equal(n, 1, `statuses ${r1.status}/${r2.status}`)
})

test('a team manager without a team reaches nothing', { skip }, async () => {
  const [tm] = await sql(`INSERT INTO users (org_id, email, role, password_hash) VALUES ($1, $2, 'team_manager', $3) RETURNING email`,
    [A.id, `tm0-${randomUUID()}@example.com`, await hashPassword(PASSWORD)])
  const c = (await login(tm.email)).cookie
  const [noTeam] = await sql(`INSERT INTO users (org_id, email, role) VALUES ($1, $2, 'member') RETURNING id`, [A.id, `nt-${randomUUID()}@example.com`])
  assert.equal((await call('users/[id]', 'POST', { as: c, params: { id: noTeam.id }, body: { action: 'rotate-key' } })).status, 403)
  assert.equal((await call('users', 'GET', { as: c })).status, 403)
  // And nobody can make one.
  assert.equal((await call('users', 'POST', { as: S.owner, body: { email: `x-${randomUUID()}@example.com`, role: 'team_manager', giveApiKey: true } })).status, 400)
})

test('passwords: your own only with the current one; team managers set none', { skip }, async () => {
  const [u] = await sql(`INSERT INTO users (org_id, email, role, password_hash) VALUES ($1, $2, 'admin', $3) RETURNING id, email`,
    [A.id, `pw-${randomUUID()}@example.com`, await hashPassword(PASSWORD)])
  const c1 = (await login(u.email)).cookie
  const c2 = (await login(u.email)).cookie
  assert.equal((await call('users/[id]', 'PATCH', { as: c1, params: { id: u.id }, body: { newPassword: 'another long password' } })).status, 403)
  assert.equal((await call('session/password', 'POST', { as: c1, body: { currentPassword: 'wrong wrong wrong', newPassword: 'another long password' } })).status, 403)
  assert.equal((await call('session/password', 'POST', { as: c1, body: { currentPassword: PASSWORD, newPassword: 'another long password' } })).status, 200)
  assert.equal((await call('users', 'GET', { as: c1 })).status, 200, 'this session stays')
  assert.equal((await call('users', 'GET', { as: c2 })).status, 401, 'the other one ends')
  assert.equal((await login(u.email, 'another long password')).status, 200)
  assert.equal((await call('users/[id]', 'PATCH', { as: S.team_manager, params: { id: A.users.member.id }, body: { newPassword: 'a password for you' } })).status, 403)
})

test('alerts: org-level ones are listed and every field edit is applied', { skip }, async () => {
  const [a] = await sql(`INSERT INTO alerts (org_id, alert_type, destination) VALUES ($1, 'quota', 'o@example.com') RETURNING id`, [A.id])
  const list = (await call('alerts', 'GET', { as: S.owner })).body
  assert.ok(list.some(x => x.id === a.id))
  const r = await call('alerts/[id]', 'PATCH', { as: S.owner, params: { id: a.id }, body: { channel: 'slack', destination: 'https://hooks.example/x' } })
  assert.equal(r.status, 200)
  assert.equal(r.body.channel, 'slack')
})
