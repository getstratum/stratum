// POST /api/internal/usage (ADR-0009): gateways report each request.
//
//   DATABASE_URL=postgres://... node --import ./test/register.mjs --test test/
//
// Skipped without DATABASE_URL.

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID, randomBytes } from 'node:crypto'

const { NextRequest } = await import('next/server.js')
const pg = (await import('pg')).default
const { closeDb } = await import('../lib/db.js')
const { hashSyncToken } = await import('../lib/instance-auth.js')
const { normalizeRecord } = await import('../lib/usage-ingest.js')
const route = await import('../app/api/internal/usage/route.js')

const url = process.env.DATABASE_URL
const skip = url ? false : 'DATABASE_URL not set'
let db
const orgs = []
const sql = async (text, params = []) => (await db.query(text, params)).rows

async function post(token, body, raw) {
  const headers = { 'content-type': 'application/json' }
  if (token) headers.authorization = `Bearer ${token}`
  const res = await route.POST(new NextRequest('http://console.test/api/internal/usage', {
    method: 'POST', headers, body: raw ?? JSON.stringify(body),
  }), { params: Promise.resolve({}) })
  const text = await res.text()
  return { status: res.status, body: text ? JSON.parse(text) : null }
}

// An organization with a team, a person, an agent and a registered gateway.
async function org() {
  const id = randomUUID()
  orgs.push(id)
  await sql('INSERT INTO organizations (id, name) VALUES ($1, $2)', [id, `u-${id.slice(0, 8)}`])
  const [team] = await sql(`INSERT INTO teams (org_id, name) VALUES ($1, 'Eng') RETURNING id`, [id])
  const [user] = await sql(`INSERT INTO users (org_id, team_id, email, role) VALUES ($1, $2, $3, 'member') RETURNING id`,
    [id, team.id, `m-${id.slice(0, 8)}@example.com`])
  const [agent] = await sql(`INSERT INTO agents (org_id, team_id, name) VALUES ($1, $2, 'bot') RETURNING id`, [id, team.id])
  const token = `dp_sync_${randomBytes(32).toString('hex')}`
  const instance = `dp_${randomBytes(16).toString('hex')}`
  await sql('INSERT INTO data_plane_instances (id, org_id, name, sync_token_hash) VALUES ($1, $2, $3, $4)',
    [instance, id, 'gw', hashSyncToken(token)])
  return { id, team: team.id, user: user.id, agent: agent.id, token, instance }
}

const record = (o, extra = {}) => ({
  id: randomUUID(), ts: new Date().toISOString(), request_id: 'req_1', key_id: o.user, team_id: o.team,
  provider: 'openai', model: 'usage-test-model', status: 200, reason: 'ok', stream: false,
  duration_ms: 812, upstream_ms: 790, tokens_in: 1000, tokens_out: 500, ...extra,
})

let A, B

before(async () => {
  if (!url) return
  db = new pg.Pool({ connectionString: url, max: 2 })
  await sql(`INSERT INTO ai_models (provider, model_id, display_name, cost_per_1k_input_tokens, cost_per_1k_output_tokens)
             VALUES ('openai', 'usage-test-model', 'Usage test', 0.002, 0.008)
             ON CONFLICT (provider, model_id) DO UPDATE SET cost_per_1k_input_tokens = 0.002, cost_per_1k_output_tokens = 0.008`)
  A = await org()
  B = await org()
})

after(async () => {
  if (!db) return
  await sql('DELETE FROM request_logs WHERE org_id = ANY($1::uuid[])', [orgs])
  await sql('DELETE FROM organizations WHERE id = ANY($1::uuid[])', [orgs])
  await sql(`DELETE FROM ai_models WHERE model_id = 'usage-test-model'`)
  await db.end()
  await closeDb()
})

test('usage: records are stored for the gateway\'s organization, with the cost from the catalog', { skip }, async () => {
  const person = record(A, { content_flags: ['email', 'email'] })
  const bot = record(A, { key_id: `agent:${A.agent}`, status: 429, reason: 'quota_exceeded', tokens_in: 0, tokens_out: 0, stream: true })
  const r = await post(A.token, { instance_id: A.instance, records: [person, bot] })
  assert.equal(r.status, 200)
  assert.deepEqual(r.body, { accepted: 2, duplicates: 0, rejected: 0 })

  const [p] = await sql('SELECT * FROM request_logs WHERE id = $1', [person.id])
  assert.equal(p.org_id, A.id)
  assert.equal(p.team_id, A.team)
  assert.equal(p.user_id, A.user)
  assert.equal(p.agent_id, null)
  assert.equal(Number(p.cost_usd), 0.006) // 1000 × 0.002/1k + 500 × 0.008/1k
  assert.equal(p.latency_ms, 812)
  assert.equal(p.provider_ms, 790)
  assert.equal(p.error_message, null)
  assert.equal(p.pii_flagged, true)
  assert.deepEqual(p.pii_types, ['email'])
  assert.equal(p.instance_id, A.instance)
  assert.equal(p.request_id, 'req_1')

  const [b] = await sql('SELECT * FROM request_logs WHERE id = $1', [bot.id])
  assert.equal(b.agent_id, A.agent)
  assert.equal(b.user_id, null)
  assert.equal(b.status_code, 429)
  assert.equal(b.error_message, 'quota_exceeded')
  assert.equal(b.is_stream, true)

  const [inst] = await sql('SELECT last_usage_at FROM data_plane_instances WHERE id = $1', [A.instance])
  assert.ok(inst.last_usage_at)
})

test('usage: a batch sent again is stored once', { skip }, async () => {
  const batch = { records: [record(A), record(A)] }
  assert.deepEqual((await post(A.token, batch)).body, { accepted: 2, duplicates: 0, rejected: 0 })
  assert.deepEqual((await post(A.token, batch)).body, { accepted: 0, duplicates: 2, rejected: 0 })
  const ids = batch.records.map(r => r.id)
  const [{ n }] = await sql('SELECT count(*)::int AS n FROM request_logs WHERE id = ANY($1::uuid[])', [ids])
  assert.equal(n, 2)
})

test('usage: a cost past the column is capped, not a failed batch', { skip }, async () => {
  // 2^31-1 tokens at 0.008/1k is ~17,000 USD: more than DECIMAL(10,6) holds.
  const big = record(A, { tokens_in: 0, tokens_out: 2_147_483_647 })
  const r = await post(A.token, { records: [big, record(A)] })
  assert.equal(r.status, 200)
  assert.equal(r.body.accepted, 2)
  const [row] = await sql('SELECT cost_usd FROM request_logs WHERE id = $1', [big.id])
  assert.equal(Number(row.cost_usd), 9999.999999)
})

test('usage: IDs from another organization are not attributed', { skip }, async () => {
  // A gateway of B reports A's team, person and agent.
  const r1 = record(B, { key_id: A.user, team_id: A.team })
  const r2 = record(B, { key_id: `agent:${A.agent}`, team_id: A.team })
  assert.equal((await post(B.token, { records: [r1, r2] })).body.accepted, 2)
  const rows = await sql('SELECT org_id, team_id, user_id, agent_id FROM request_logs WHERE id = ANY($1::uuid[])', [[r1.id, r2.id]])
  for (const row of rows) {
    assert.equal(row.org_id, B.id)
    assert.equal(row.team_id, null)
    assert.equal(row.user_id, null)
    assert.equal(row.agent_id, null)
  }
})

test('usage: only an enabled gateway with its own token', { skip }, async () => {
  assert.equal((await post(null, { records: [] })).status, 401)
  assert.equal((await post('dp_sync_wrong', { records: [] })).status, 401)
  assert.equal((await post(A.token, { instance_id: B.instance, records: [] })).status, 403)
  await sql('UPDATE data_plane_instances SET disabled = true WHERE id = $1', [B.instance])
  assert.equal((await post(B.token, { records: [record(B)] })).status, 401)
  await sql('UPDATE data_plane_instances SET disabled = false WHERE id = $1', [B.instance])
})

test('usage: malformed batches are refused; malformed records are skipped', { skip }, async () => {
  assert.equal((await post(A.token, null, '{nope')).status, 400)
  assert.equal((await post(A.token, { records: 'x' })).status, 400)
  assert.equal((await post(A.token, { records: Array.from({ length: 501 }, () => record(A)) })).status, 413)

  const good = record(A)
  const r = await post(A.token, { records: [good, { ...record(A), id: 'not-a-uuid' }, { ...record(A), tokens_in: -1 }] })
  assert.equal(r.status, 200)
  assert.deepEqual(r.body, { accepted: 1, duplicates: 0, rejected: 2 })
})

test('usage: the contract example is accepted', { skip }, async () => {
  const { readFile } = await import('node:fs/promises')
  const example = JSON.parse(await readFile(new URL('../../../api/usage/v1/examples/batch.json', import.meta.url)))
  const records = example.records.map(r => ({ ...r, id: randomUUID(), ts: new Date().toISOString() }))
  const r = await post(A.token, { records })
  assert.equal(r.status, 200)
  assert.deepEqual(r.body, { accepted: records.length, duplicates: 0, rejected: 0 })
})

test('normalizeRecord: bounds on time, numbers and text', () => {
  const now = Date.parse('2026-10-16T12:00:00Z')
  const base = {
    id: randomUUID(), ts: '2026-10-16T11:59:00Z', key_id: 'k', status: 200, stream: false,
    duration_ms: 1, upstream_ms: 1, tokens_in: 1, tokens_out: 1,
  }
  assert.ok(normalizeRecord(base, now))
  assert.equal(normalizeRecord({ ...base, ts: '2026-08-01T00:00:00Z' }, now), null, 'older than 35 days')
  assert.equal(normalizeRecord({ ...base, ts: '2026-10-16T12:10:00Z' }, now), null, 'ten minutes in the future')
  assert.equal(normalizeRecord({ ...base, status: 999 }, now), null)
  assert.equal(normalizeRecord({ ...base, stream: 'yes' }, now), null)
  assert.equal(normalizeRecord({ ...base, reason: 'Robert"); DROP' }, now), null)
  assert.equal(normalizeRecord({ ...base, content_flags: ['ok', 7] }, now), null)
  assert.equal(normalizeRecord({ ...base, tokens_in: 1.5 }, now), null)

  const big = normalizeRecord({ ...base, tokens_out: 5_000_000_000, model: 'm'.repeat(300), team_id: 'not-a-uuid' }, now)
  assert.equal(big.tokens_out, 2_147_483_647)
  assert.equal(big.model.length, 100)
  assert.equal(big.team_id, null)
  assert.equal(big.reason, 'ok')
})
