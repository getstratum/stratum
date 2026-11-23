// An organization's plan limits (ADR-0020, migration 046), against
// PostgreSQL: the console refuses to go past them, gateways get the monthly
// ones with each sync, and the daily maintenance applies the retention.
//
//   DATABASE_URL=postgres://... node --import ./test/register.mjs --test test/
//
// Skipped without DATABASE_URL, except the validation.

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID, randomBytes, createHash } from 'node:crypto'

process.env.STRATUM_ENCRYPTION_KEY ??= randomBytes(32).toString('hex')

const { NextRequest } = await import('next/server.js')
const pg = (await import('pg')).default
const { hashPassword } = await import('../lib/password.js')
const { closeDb } = await import('../lib/db.js')
const { buildSyncResponse } = await import('../lib/sync.js')
const { mergeLimits, withRoom, applyRetention, countAll } = await import('../lib/org-limits.js')

const url = process.env.DATABASE_URL
const skip = url ? false : 'DATABASE_URL not set'
const PASSWORD = 'correct horse battery'
let db
const orgs = []

const mods = {}
async function call(path, method, { as, body, params = {} } = {}) {
  mods[path] ??= await import(`../app/api/${path}/route.js`)
  const headers = {}
  if (as) headers.cookie = `stratum_session=${as}`
  if (body !== undefined) headers['content-type'] = 'application/json'
  const req = new NextRequest(`http://console.test/api/${path}`, {
    method, headers, body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const res = await mods[path][method](req, { params: Promise.resolve(params) })
  const text = await res.text()
  return { status: res.status, body: text ? JSON.parse(text) : null }
}

const sql = async (text, params = []) => (await db.query(text, params)).rows

// An organization with its Owner signed in, and the given limits.
async function org(limits = {}, plan = null) {
  const id = randomUUID()
  orgs.push(id)
  await sql('INSERT INTO organizations (id, name, limits, plan_name) VALUES ($1, $2, $3, $4)',
    [id, `l-${id.slice(0, 8)}`, limits, plan])
  const email = `owner-${id.slice(0, 8)}@example.com`
  await sql(`INSERT INTO users (org_id, email, role, password_hash) VALUES ($1, $2, 'owner', $3)`,
    [id, email, await hashPassword(PASSWORD)])
  // A signed-in session, as if the Owner had set up the second factor.
  const token = randomBytes(32).toString('hex')
  await sql(`INSERT INTO console_sessions (token_hash, user_id, org_id, expires_at, enrollment_only)
             SELECT $1, u.id, u.org_id, now() + interval '1 hour', false FROM users u WHERE u.email = $2`,
    [createHash('sha256').update(token).digest('hex'), email])
  return { id, owner: token }
}

const setLimits = (id, limits, plan = null) =>
  sql('UPDATE organizations SET limits = $2, plan_name = $3 WHERE id = $1', [id, limits, plan])

before(() => { if (url) db = new pg.Pool({ connectionString: url, max: 4 }) })
after(async () => {
  if (!db) return
  await sql('DELETE FROM organizations WHERE id = ANY($1::uuid[])', [orgs])
  await db.end()
  await closeDb()
})

test('limits: validated, merged, and removed with null', () => {
  assert.deepEqual(mergeLimits({ people: 5 }, { teams: '3', monthly_budget_usd: 99.999 }),
    { people: 5, teams: 3, monthly_budget_usd: 100 })
  assert.deepEqual(mergeLimits({ people: 5, teams: 3 }, { people: null }), { teams: 3 })
  assert.throws(() => mergeLimits({}, { seats: 3 }), /Unknown limit/)
  assert.throws(() => mergeLimits({}, { people: 2.5 }), /whole number/)
  assert.throws(() => mergeLimits({}, { agents: -1 }), /0 or more/)
  assert.throws(() => mergeLimits({}, { teams: 'many' }), /whole number/)
  assert.throws(() => mergeLimits({}, { retention_days: 7 }), /at least 31/)
  assert.deepEqual(mergeLimits({}, { people: 0 }), { people: 0 })
})

test('limits: without a plan nothing changes', { skip }, async () => {
  const A = await org()
  for (let i = 0; i < 3; i++) {
    assert.equal((await call('teams', 'POST', { as: A.owner, body: { name: `t${i}` } })).status, 201)
  }
})

test('limits: people, agents, teams and gateways stop at the plan, with its name', { skip }, async () => {
  const A = await org({ people: 2, agents: 1, teams: 1, gateways: 1 }, 'Equipo')

  const team = await call('teams', 'POST', { as: A.owner, body: { name: 'Ventas' } })
  assert.equal(team.status, 201)
  const over = await call('teams', 'POST', { as: A.owner, body: { name: 'Soporte' } })
  assert.equal(over.status, 409)
  assert.equal(over.body.error, 'plan_limit')
  assert.match(over.body.message, /Llegaste al límite de tu plan \(Equipo\): 1 equipo\./)

  // The Owner is one person: one more fits, the next one does not.
  const ana = await call('users', 'POST', { as: A.owner, body: { email: `ana-${A.id.slice(0, 6)}@example.com`, giveApiKey: true } })
  assert.equal(ana.status, 201)
  const beto = await call('users', 'POST', { as: A.owner, body: { email: `beto-${A.id.slice(0, 6)}@example.com`, giveApiKey: true } })
  assert.equal(beto.status, 409)
  assert.match(beto.body.message, /2 personas activas/)
  assert.equal((await sql('SELECT count(*)::int AS n FROM users WHERE org_id = $1', [A.id]))[0].n, 2)

  // Someone turned off makes room; turning them back on needs it again.
  const off = await call('users/[id]', 'PATCH', { as: A.owner, params: { id: ana.body.user.id }, body: { isActive: false } })
  assert.equal(off.status, 200)
  const carla = await call('users', 'POST', { as: A.owner, body: { email: `carla-${A.id.slice(0, 6)}@example.com`, giveApiKey: true } })
  assert.equal(carla.status, 201)
  const back = await call('users/[id]', 'PATCH', { as: A.owner, params: { id: ana.body.user.id }, body: { isActive: true } })
  assert.equal(back.status, 409)
  // Other changes to someone inactive still go.
  assert.equal((await call('users/[id]', 'PATCH', { as: A.owner, params: { id: ana.body.user.id }, body: { name: 'Ana' } })).status, 200)

  const agent = await call('agents', 'POST', { as: A.owner, body: { name: 'bot', teamId: team.body.id } })
  assert.equal(agent.status, 201)
  assert.equal((await call('agents', 'POST', { as: A.owner, body: { name: 'bot2', teamId: team.body.id } })).status, 409)
  assert.equal((await call('agents/[id]', 'PATCH', { as: A.owner, params: { id: agent.body.agent.id }, body: { isActive: false } })).status, 200)
  assert.equal((await call('agents', 'POST', { as: A.owner, body: { name: 'bot2', teamId: team.body.id } })).status, 201)
  assert.equal((await call('agents/[id]', 'PATCH', { as: A.owner, params: { id: agent.body.agent.id }, body: { isActive: true } })).status, 409)

  assert.equal((await call('internal/instances', 'POST', { as: A.owner, body: { label: 'gw1' } })).status, 201)
  assert.equal((await call('internal/instances', 'POST', { as: A.owner, body: { label: 'gw2' } })).status, 409)

  // Lowering a limit removes nothing: it only stops adding.
  await setLimits(A.id, { people: 1, agents: 1, teams: 1, gateways: 1 })
  assert.deepEqual(
    Object.fromEntries(Object.entries(await countAll(db, A.id)).filter(([k]) => ['people', 'teams'].includes(k))),
    { people: 2, teams: 1 })
  const lowered = await call('teams', 'POST', { as: A.owner, body: { name: 'Otro' } })
  assert.match(lowered.body.message, /^Llegaste al límite de tu plan: 1 equipo\./)
})

test('limits: two requests at once cannot both take the last place', { skip }, async () => {
  const A = await org({ teams: 1 })
  const results = await Promise.allSettled([1, 2, 3].map(i =>
    withRoom(db, A.id, 'teams', tx => tx.query(`INSERT INTO teams (org_id, name) VALUES ($1, $2)`, [A.id, `c${i}`]))))
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1)
  assert.ok(results.filter(r => r.status === 'rejected').every(r => r.reason.code === 'plan_limit'))
  assert.equal((await sql('SELECT count(*)::int AS n FROM teams WHERE org_id = $1', [A.id]))[0].n, 1)
})

test('limits: the monthly ones travel to gateways with every sync', { skip }, async () => {
  const A = await org()
  const sync = async (since) => {
    const client = await db.connect()
    try { return await buildSyncResponse(client, { orgId: A.id, sinceVersion: since, syncIntervalS: 30, decrypt: v => v, warn: () => {} }) } finally { client.release() }
  }
  assert.deepEqual((await sync(0)).organization, { status: 'active' })
  await setLimits(A.id, { monthly_tokens: 5000000, monthly_budget_usd: 250.5, people: 10 })
  const full = await sync(0)
  assert.deepEqual(full.organization, { status: 'active', monthly_token_quota: 5000000, monthly_budget_usd: 250.5 })
  // Not versioned: a delta carries them too.
  assert.deepEqual((await sync(full.current_version)).organization, full.organization)
})

test('limits: the retention deletes older requests, and keeps the month\'s usage', { skip }, async () => {
  const A = await org({ retention_days: 31 })
  const B = await org()
  const [team] = await sql(`INSERT INTO teams (org_id, name) VALUES ($1, 't') RETURNING id`, [A.id])
  for (const o of [A, B]) {
    await sql(`INSERT INTO request_logs (org_id, team_id, provider, model_id, tokens_input, created_at)
               VALUES ($1, $2, 'openai', 'gpt-4o', 10, now() - interval '40 days'),
                      ($1, $2, 'openai', 'gpt-4o', 10, now() - interval '45 days'),
                      ($1, $2, 'openai', 'gpt-4o', 10, now() - interval '2 days')`,
      [o.id, o === A ? team.id : null])
    await sql(`INSERT INTO task_outcomes (id, created_at, org_id, task, outcome)
               VALUES ($1, now() - interval '40 days', $2, 'x', 'resolved'), ($3, now(), $2, 'x', 'resolved')`,
      [randomUUID(), o.id, randomUUID()])
  }
  const usageBefore = await sql('SELECT month, tokens FROM team_usage_monthly WHERE org_id = $1 ORDER BY month', [A.id])
  assert.ok(usageBefore.length > 0)

  const done = (await applyRetention(db, { batch: 1 })).filter(d => d.orgId === A.id)
  assert.deepEqual(done.map(d => [d.requests, d.outcomes]), [[2, 1]])
  const left = async (o) => (await sql('SELECT count(*)::int AS n FROM request_logs WHERE org_id = $1', [o.id]))[0].n
  assert.equal(await left(A), 1)
  assert.equal(await left(B), 3) // no retention in its plan
  assert.equal((await sql('SELECT count(*)::int AS n FROM task_outcomes WHERE org_id = $1', [A.id]))[0].n, 1)
  assert.deepEqual(await sql('SELECT month, tokens FROM team_usage_monthly WHERE org_id = $1 ORDER BY month', [A.id]), usageBefore)
})

test('limits: "Mi organización" shows the plan, and the session what it fixes', { skip }, async () => {
  const none = await org()
  const s0 = await call('session', 'GET', { as: none.owner })
  assert.deepEqual([s0.body.org.managed, s0.body.org.plan, s0.body.org.reached], [false, null, {}])

  const A = await org({ people: 1, teams: 5, monthly_tokens: 1000, retention_days: 60 }, 'Equipo')
  const [team] = await sql(`INSERT INTO teams (org_id, name) VALUES ($1, 't') RETURNING id`, [A.id])
  await sql(`INSERT INTO request_logs (org_id, team_id, provider, model_id, tokens_input, tokens_output, cost_usd)
             VALUES ($1, $2, 'openai', 'gpt-4o', 300, 100, 0.5)`, [A.id, team.id])

  const s = await call('session', 'GET', { as: A.owner })
  assert.equal(s.body.org.managed, true)
  assert.equal(s.body.org.plan, 'Equipo')
  // The Owner is the one person the plan allows.
  assert.deepEqual(s.body.org.reached, { people: 'Fijado por tu plan (Equipo): 1 persona activa.' })

  const o = await call('org', 'GET', { as: A.owner })
  assert.equal(o.status, 200)
  assert.deepEqual(o.body.limits, { people: 1, teams: 5, monthly_tokens: 1000, retention_days: 60 })
  assert.deepEqual([o.body.counts.people, o.body.counts.teams, o.body.counts.monthly_tokens, o.body.counts.monthly_budget_usd], [1, 1, 400, 0.5])
  assert.equal(o.body.status, 'active')
})
