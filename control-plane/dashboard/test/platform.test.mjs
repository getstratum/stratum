// The platform API (ADR-0020, migration 048), against PostgreSQL: a token
// outside every organization lists, creates, suspends, deletes and sets the
// plan of organizations, and reads their usage for billing. Nothing else
// opens it, and it opens nothing else.
//
//   DATABASE_URL=postgres://... node --import ./test/register.mjs --test test/
//
// Skipped without DATABASE_URL.

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID, randomBytes, createHash } from 'node:crypto'

process.env.STRATUM_ENCRYPTION_KEY ??= randomBytes(32).toString('hex')

const { NextRequest } = await import('next/server.js')
const pg = (await import('pg')).default
const { closeDb } = await import('../lib/db.js')
const { createPlatformToken, revokePlatformToken } = await import('../lib/platform.js')
const { createToken } = await import('../lib/service-tokens.js')

const url = process.env.DATABASE_URL
const skip = url ? false : 'DATABASE_URL not set'
let db, TOKEN, tokenName
const orgs = []

const mods = {}
async function call(path, method, { bearer = TOKEN, actor, body, query = '', params = {}, cookie } = {}) {
  mods[path] ??= await import(`../app/api/${path}/route.js`)
  const headers = {}
  if (bearer) headers.authorization = `Bearer ${bearer}`
  if (actor) headers['x-stratum-actor'] = actor
  if (cookie) headers.cookie = `stratum_session=${cookie}`
  if (body !== undefined) headers['content-type'] = 'application/json'
  const req = new NextRequest(`http://console.test/api/${path}${query}`, {
    method, headers, body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const res = await mods[path][method](req, { params: Promise.resolve(params) })
  const text = await res.text()
  let parsed = null
  try { parsed = text ? JSON.parse(text) : null } catch { parsed = text }
  return { status: res.status, body: parsed, headers: res.headers }
}

const sql = async (text, params = []) => (await db.query(text, params)).rows
const unique = (s) => `${s} ${randomBytes(3).toString('hex')}`

before(async () => {
  if (!url) return
  db = new pg.Pool({ connectionString: url, max: 4 })
  tokenName = unique('operator')
  TOKEN = (await createPlatformToken(db, { name: tokenName, days: 30 })).raw
})
after(async () => {
  if (!db) return
  await sql('DELETE FROM organizations WHERE id = ANY($1::uuid[])', [orgs])
  await db.end()
  await closeDb()
})

async function create(body) {
  const r = await call('platform/organizations', 'POST', { body })
  if (r.status === 201) orgs.push(r.body.id)
  return r
}

test('platform: only a platform token opens it', { skip }, async () => {
  assert.equal((await call('platform/organizations', 'GET', { bearer: null })).status, 401)
  assert.equal((await call('platform/organizations', 'GET', { bearer: 'stplat_nope' })).status, 401)

  // An organization's service token, even with every scope, is not a platform token.
  const [o] = await sql(`INSERT INTO organizations (name) VALUES ($1) RETURNING id`, [unique('svc')])
  orgs.push(o.id)
  const svc = await createToken(db, { orgId: o.id, userId: null }, { name: 'all', scopes: ['users.read', 'audit.read'], days: 30 })
  assert.equal((await call('platform/organizations', 'GET', { bearer: svc.raw })).status, 401)

  // And a platform token is not an organization's: it opens none of its routes.
  assert.equal((await call('users', 'GET')).status, 401)

  // Revoked or expired, it stops at once.
  const t = await createPlatformToken(db, { name: 'short', days: 1 })
  assert.equal((await call('platform/organizations', 'GET', { bearer: t.raw })).status, 200)
  assert.ok(await revokePlatformToken(db, t.id))
  assert.equal((await call('platform/organizations', 'GET', { bearer: t.raw })).status, 401)
  const e = await createPlatformToken(db, { name: 'expired', days: 1 })
  await sql(`UPDATE platform_tokens SET expires_at = now() - interval '1 s' WHERE id = $1`, [e.id])
  assert.equal((await call('platform/organizations', 'GET', { bearer: e.raw })).status, 401)
})

test('platform: create, list and set the plan; never what is inside', { skip }, async () => {
  const name = unique('Acme')
  const r = await create({ name, plan: 'Empresa', limits: { people: 25, monthly_tokens: 5000000 } })
  assert.equal(r.status, 201)
  assert.equal(r.body.plan, 'Empresa')
  assert.deepEqual(r.body.limits, { people: 25, monthly_tokens: 5000000 })
  assert.equal(r.body.counts.people, 0)

  assert.equal((await create({ name: name.toUpperCase() })).status, 409)
  assert.equal((await create({ name: '  ' })).status, 400)
  assert.equal((await create({ name: unique('x'), limits: { seats: 3 } })).status, 400)
  assert.equal((await create({ name: unique('x'), limits: [1] })).status, 400)

  // People and requests of the organization stay inside it.
  await sql(`INSERT INTO users (org_id, email, role) VALUES ($1, $2, 'owner')`, [r.body.id, `o-${r.body.id}@example.com`])
  const list = await call('platform/organizations', 'GET')
  const mine = list.body.organizations.find(o => o.id === r.body.id)
  assert.deepEqual(Object.keys(mine).sort(), ['counts', 'created_at', 'delete_after', 'id', 'limits', 'name', 'plan', 'status'])
  assert.equal(mine.counts.people, 1)
  assert.ok(!JSON.stringify(list.body).includes('@example.com'))

  const p = await call('platform/organizations/[id]', 'PATCH', { params: { id: r.body.id }, actor: 'ana@matech.lat',
    body: { plan: 'Equipo', limits: { people: null, teams: 3 } } })
  assert.equal(p.status, 200)
  assert.equal(p.body.plan, 'Equipo')
  assert.deepEqual(p.body.limits, { teams: 3, monthly_tokens: 5000000 })
  assert.equal((await call('platform/organizations/[id]', 'PATCH', { params: { id: r.body.id }, body: { limits: { retention_days: 7 } } })).status, 400)
  assert.equal((await call('platform/organizations/[id]', 'PATCH', { params: { id: randomUUID() }, body: { plan: 'x' } })).status, 404)
  assert.equal((await call('platform/organizations/[id]', 'GET', { params: { id: 'nope' } })).status, 404)

  // Both audit logs: the platform's names the token and whom its client said.
  const [pa] = await sql(`SELECT actor, details FROM platform_audit WHERE org_id = $1 AND action = 'org.limits'`, [r.body.id])
  assert.equal(pa.actor, `platform:${tokenName} (ana@matech.lat)`)
  assert.deepEqual(pa.details.plan, { from: 'Empresa', to: 'Equipo' })
  const own = await sql(`SELECT action FROM audit_log WHERE org_id = $1 ORDER BY id`, [r.body.id])
  assert.deepEqual(own.map(e => e.action), ['org.create', 'org.limits'])
})

test('platform: suspend, resume, delete and undelete, with reasons', { skip }, async () => {
  const name = unique('Beta')
  const { body: org } = await create({ name })
  const act = (body) => call('platform/organizations/[id]', 'POST', { params: { id: org.id }, body })

  assert.equal((await act({ action: 'suspend' })).status, 400)
  assert.equal((await act({ action: 'explode', reason: 'porque sí' })).status, 400)
  assert.equal((await act({ action: 'suspend', reason: 'falta de pago' })).body.status, 'suspended')
  assert.equal((await act({ action: 'resume', reason: 'pagó la factura' })).body.status, 'active')

  assert.equal((await act({ action: 'delete', reason: 'cliente se fue', confirm: 'Beta' })).status, 400)
  const d = await act({ action: 'delete', reason: 'cliente se fue', confirm: name })
  assert.equal(d.status, 200)
  assert.equal(d.body.status, 'suspended')
  assert.ok(d.body.delete_after)
  assert.equal((await act({ action: 'resume', reason: 'pagó la factura' })).status, 409)
  assert.equal((await act({ action: 'delete', reason: 'otra vez', confirm: name })).status, 409)
  const u = await act({ action: 'undelete', reason: 'se arrepintió' })
  assert.equal(u.body.status, 'active')
  assert.equal(u.body.delete_after, null)

  const audit = await call('platform/audit', 'GET', { query: `?org_id=${org.id}` })
  assert.deepEqual(audit.body.entries.map(e => e.action),
    ['org.undelete', 'org.delete', 'org.resume', 'org.suspend', 'org.create'])
  const page = await call('platform/audit', 'GET', { query: `?org_id=${org.id}&limit=2&before=${audit.body.entries[1].id}` })
  assert.deepEqual(page.body.entries.map(e => e.action), ['org.resume', 'org.suspend'])
})

test('platform: usage per month for billing, as JSON or CSV', { skip }, async () => {
  const { body: org } = await create({ name: unique('=Gamma'), plan: 'Empresa' })
  const [team] = await sql(`INSERT INTO teams (org_id, name) VALUES ($1, 't') RETURNING id`, [org.id])
  await sql(`INSERT INTO request_logs (org_id, team_id, provider, model_id, tokens_input, tokens_output, cost_usd, created_at)
             VALUES ($1, $2, 'openai', 'gpt-4o', 1000, 500, 0.25, '2026-10-15T12:00:00Z'),
                    ($1, $2, 'openai', 'gpt-4o', 100, 50, 0.05, '2026-10-20T12:00:00Z'),
                    ($1, $2, 'openai', 'gpt-4o', 1, 1, 1, '2026-09-30T23:59:00Z')`, [org.id, team.id])

  const r = await call('platform/usage', 'GET', { query: '?month=2026-10' })
  assert.equal(r.status, 200)
  const row = r.body.organizations.find(o => o.id === org.id)
  assert.deepEqual([row.tokens, row.requests, row.cost_usd, row.teams, row.plan], [1650, 2, 0.3, 1, 'Empresa'])
  assert.equal((await call('platform/usage', 'GET', { query: '?month=2026-13' })).status, 400)

  const csv = await call('platform/usage', 'GET', { query: '?month=2026-10&format=csv' })
  assert.match(csv.headers.get('content-type'), /text\/csv/)
  const line = csv.body.split('\r\n').find(l => l.includes(org.id))
  // A name that starts like a formula is not run by a spreadsheet.
  assert.ok(line.startsWith(`2026-10,${org.id},'=Gamma`), line)
  assert.ok(line.endsWith(',1650,0.3,2,0,0,1,0'), line)
})
