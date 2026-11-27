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
const { estimate, METHOD } = await import('../lib/impacts/index.js')
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

test('usage: the cost is found by model ID or alias (migration 023)', { skip }, async () => {
  const alias = record(A, { provider: 'anthropic', model: 'claude-haiku-4-5', tokens_in: 1000, tokens_out: 500 })
  const dated = record(A, { provider: 'anthropic', model: 'claude-haiku-4-5-20251001', tokens_in: 1000, tokens_out: 500 })
  const gemini = record(A, { provider: 'gemini', model: 'gemini-3.8-flash', tokens_in: 1000, tokens_out: 1000 })
  assert.equal((await post(A.token, { records: [alias, dated, gemini] })).body.accepted, 3)
  const cost = async r => Number((await sql('SELECT cost_usd FROM request_logs WHERE id = $1', [r.id]))[0].cost_usd)
  assert.equal(await cost(alias), 0.0035) // 1000 × $1/M + 500 × $5/M
  assert.equal(await cost(dated), 0.0035)
  assert.equal(await cost(gemini), 0.0045) // provider "gemini", as gateways call it
})

test('usage: a model without a price costs NULL ("sin precio"), not a 0 that reads as free', { skip }, async () => {
  const unpriced = record(A, { provider: 'groq', model: 'openai/gpt-oss-20b' })
  const refused = record(A, { provider: 'groq', model: 'openai/gpt-oss-20b', status: 403, reason: 'model_not_allowed', tokens_in: 0, tokens_out: 0 })
  assert.equal((await post(A.token, { records: [unpriced, refused] })).body.accepted, 2)
  const cost = async r => (await sql('SELECT cost_usd FROM request_logs WHERE id = $1', [r.id]))[0].cost_usd
  assert.equal(await cost(unpriced), null)
  assert.equal(Number(await cost(refused)), 0) // no tokens: nothing to price
})

test('usage: images and audio are priced per image and per minute (ADR-0018), beside tokens', { skip }, async () => {
  await sql(`INSERT INTO org_model_settings (org_id, provider, model_id, cost_per_audio_minute) VALUES ($1, 'groq', 'whisper-large-v3', 0.00185)
             ON CONFLICT (org_id, provider, model_id) DO UPDATE SET cost_per_audio_minute = 0.00185`, [A.id])
  await sql(`INSERT INTO org_model_settings (org_id, provider, model_id, cost_per_image, cost_per_1k_input_tokens, cost_per_1k_output_tokens)
             VALUES ($1, 'openai', 'img-test', 0.04, 0.002, 0.008)
             ON CONFLICT (org_id, provider, model_id) DO UPDATE SET cost_per_image = 0.04`, [A.id])
  const audio = record(A, { provider: 'groq', model: 'whisper-large-v3', tokens_in: 0, tokens_out: 0, audio_seconds: 120 })
  const image = record(A, { provider: 'openai', model: 'img-test', tokens_in: 1000, tokens_out: 0, images: 2 })
  const unpriced = record(A, { provider: 'groq', model: 'whisper-sin-precio', tokens_in: 0, tokens_out: 0, audio_seconds: 60 })
  assert.equal((await post(A.token, { records: [audio, image, unpriced] })).body.accepted, 3)
  const row = async r => (await sql('SELECT cost_usd, images, audio_seconds FROM request_logs WHERE id = $1', [r.id]))[0]
  const a = await row(audio)
  assert.equal(Number(a.cost_usd), 0.0037) // 2 minutes × 0.00185
  assert.equal(Number(a.audio_seconds), 120)
  const i = await row(image)
  assert.equal(Number(i.cost_usd), 0.082) // 1000 × 0.002/1k + 2 × 0.04
  assert.equal(i.images, 2)
  assert.equal((await row(unpriced)).cost_usd, null)
})

test('usage: the prompt cache is input, priced apart: Anthropic\'s multipliers, or the organization\'s price (migration 052)', { skip }, async () => {
  await sql(`INSERT INTO ai_models (provider, model_id, display_name, cost_per_1k_input_tokens, cost_per_1k_output_tokens)
             VALUES ('anthropic', 'claude-cache-test', 'Cache test', 0.003, 0.015)
             ON CONFLICT (provider, model_id) DO UPDATE SET cost_per_1k_input_tokens = 0.003, cost_per_1k_output_tokens = 0.015`)
  try {
    // 87,000 written and 12 not cached: what Stratum counted as 12 before.
    const write = record(A, { provider: 'anthropic', model: 'claude-cache-test', tokens_in: 87012, tokens_out: 300, tokens_cache_write: 87000 })
    const read = record(A, { provider: 'anthropic', model: 'claude-cache-test', tokens_in: 40005, tokens_out: 9, tokens_cache_read: 40000 })
    // OpenAI: the cached part of prompt_tokens, at the input price unless the organization set one.
    const oai = record(A, { tokens_in: 2048, tokens_out: 7, tokens_cache_read: 1920 })
    // More cache than input: bounded, not trusted.
    const odd = record(A, { provider: 'anthropic', model: 'claude-cache-test', tokens_in: 100, tokens_out: 0, tokens_cache_write: 80, tokens_cache_read: 500 })
    assert.equal((await post(A.token, { records: [write, read, oai, odd] })).body.accepted, 4)
    const row = async r => (await sql('SELECT tokens_input, cost_usd, tokens_cache_write, tokens_cache_read FROM request_logs WHERE id = $1', [r.id]))[0]
    const w = await row(write)
    assert.equal(w.tokens_input, 87012)
    assert.equal(w.tokens_cache_write, 87000)
    assert.equal(w.tokens_cache_read, null)
    assert.equal(Number(w.cost_usd), 0.330786) // 12 × 0.003 + 87000 × 0.00375 + 300 × 0.015, per 1k
    const r = await row(read)
    assert.equal(r.tokens_cache_read, 40000)
    assert.equal(Number(r.cost_usd), 0.01215) // 5 × 0.003 + 40000 × 0.0003 + 9 × 0.015, per 1k
    assert.equal(Number((await row(oai)).cost_usd), 0.004152) // 2048 × 0.002 + 7 × 0.008, per 1k: as before
    const o = await row(odd)
    assert.deepEqual([o.tokens_cache_write, o.tokens_cache_read], [80, 20])

    // The organization's own cache price wins.
    await sql(`INSERT INTO org_model_settings (org_id, provider, model_id, cost_per_1k_cache_read_tokens) VALUES ($1, 'openai', 'usage-test-model', 0.001)
               ON CONFLICT (org_id, provider, model_id) DO UPDATE SET cost_per_1k_cache_read_tokens = 0.001`, [A.id])
    const own = record(A, { tokens_in: 2048, tokens_out: 7, tokens_cache_read: 1920 })
    await post(A.token, { records: [own] })
    assert.equal(Number((await row(own)).cost_usd), 0.002232) // 128 × 0.002 + 1920 × 0.001 + 7 × 0.008, per 1k
  } finally {
    await sql(`DELETE FROM org_model_settings WHERE org_id = $1 AND model_id = 'usage-test-model'`, [A.id])
    await sql(`DELETE FROM request_logs WHERE model_id = 'claude-cache-test'`)
    await sql(`DELETE FROM ai_models WHERE model_id = 'claude-cache-test'`)
  }
})

test('usage: where a request came from, as the gateway saw it (migration 054); anything malformed is left out', { skip }, async () => {
  const ok = record(A, { client_ip: '198.51.100.9', user_agent: 'daty-worker/1.4 (cron)' })
  const v6 = record(A, { client_ip: '2001:db8::7', user_agent: `x\u0001y${'z'.repeat(300)}` })
  const bad = record(A, { client_ip: 'not-an-ip; DROP TABLE', user_agent: 42 })
  const none = record(A)
  assert.equal((await post(A.token, { records: [ok, v6, bad, none] })).body.accepted, 4)
  const row = async r => (await sql('SELECT host(client_ip) AS ip, user_agent FROM request_logs WHERE id = $1', [r.id]))[0]
  assert.deepEqual(await row(ok), { ip: '198.51.100.9', user_agent: 'daty-worker/1.4 (cron)' })
  const six = await row(v6)
  assert.equal(six.ip, '2001:db8::7')
  assert.equal(six.user_agent.length, 200)
  assert.ok(six.user_agent.startsWith('xyz'))
  assert.deepEqual(await row(bad), { ip: null, user_agent: null })
  assert.deepEqual(await row(none), { ip: null, user_agent: null })
})

test('usage: each request gets its estimated impact; an unknown model or no output gets none', { skip }, async () => {
  const known = record(A, { provider: 'openai', model: 'gpt-4o-mini', tokens_out: 400, duration_ms: 6000 })
  const unknown = record(A, { provider: 'ollama', model: 'mock-fast', tokens_out: 400 })
  const refused = record(A, { provider: 'openai', model: 'gpt-4o-mini', status: 429, reason: 'quota_exceeded', tokens_in: 0, tokens_out: 0 })
  assert.equal((await post(A.token, { records: [known, unknown, refused] })).body.accepted, 3)
  const row = async r => (await sql('SELECT * FROM request_logs WHERE id = $1', [r.id]))[0]

  const k = await row(known)
  const want = estimate({ provider: 'openai', model: 'gpt-4o-mini', tokensOut: 400, durationMs: 6000 })
  for (const [col, key] of [['energy_wh', 'energy_wh'], ['gwp_g', 'gwp_g'], ['water_ml', 'water_ml'], ['pe_kj', 'pe_kj'], ['adpe_mg', 'adpe_mg_sb']]) {
    assert.equal(k[`impact_${col}_min`], want[key].min, col)
    assert.equal(k[`impact_${col}_max`], want[key].max, col)
  }
  assert.ok(k.impact_gwp_g_min > 0 && k.impact_gwp_g_min < k.impact_gwp_g_max, 'a closed model: a range')
  assert.equal(k.impact_zone, 'USA')
  assert.equal(k.impact_method, METHOD)

  for (const r of [unknown, refused]) {
    const u = await row(r)
    assert.equal(u.impact_energy_wh_min, null)
    assert.equal(u.impact_gwp_g_max, null)
    assert.equal(u.impact_method, null)
  }
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

// ADR-0019: the task on each request, and a task's end kept apart.
test('usage: a task on each request; an outcome is a task\'s end, not a request', { skip }, async () => {
  const bot = `agent:${A.agent}`
  const r1 = record(A, { key_id: bot, task: 'ticket-7', agent_version: 'v12' })
  const r2 = record(A, { key_id: bot, task: 'bad task' })
  const end = record(A, { key_id: bot, provider: 'stratum', model: 'task', reason: 'task_outcome', tokens_in: 0, tokens_out: 0,
    task: 'ticket-7', outcome: 'escalated', outcome_reason: 'customer_asked_for_a_person', agent_version: 'v12' })
  const noTask = record(A, { key_id: bot, outcome: 'resolved' })
  const badOutcome = record(A, { key_id: bot, task: 'ticket-7', outcome: 'done' })
  const res = await post(A.token, { instance_id: A.instance, records: [r1, r2, end, noTask, badOutcome] })
  assert.equal(res.status, 200)
  assert.deepEqual(res.body, { accepted: 3, duplicates: 0, rejected: 2 })
  const logs = await sql('SELECT id::text, task FROM request_logs WHERE id = ANY($1::uuid[]) ORDER BY task NULLS LAST', [[r1.id, r2.id, end.id]])
  assert.deepEqual(logs.map(l => [l.id, l.task]), [[r1.id, 'ticket-7'], [r2.id, null]], 'the end is not a request')
  const [o] = await sql('SELECT * FROM task_outcomes WHERE id = $1', [end.id])
  assert.equal(o.org_id, A.id)
  assert.equal(o.agent_id, A.agent)
  assert.equal(o.team_id, A.team)
  assert.equal(o.outcome, 'escalated')
  assert.equal(o.reason, 'customer_asked_for_a_person')
  assert.equal(o.instance_id, A.instance)
  assert.equal(o.agent_version, 'v12')
  assert.equal((await sql('SELECT agent_version FROM request_logs WHERE id = $1', [r1.id]))[0].agent_version, 'v12')
  // Sent again: stored once.
  assert.deepEqual((await post(A.token, { instance_id: A.instance, records: [end] })).body, { accepted: 0, duplicates: 1, rejected: 0 })
  // Another organization's agent is not attributed.
  const other = record(B, { key_id: bot, provider: 'stratum', model: 'task', task: 'x-1', outcome: 'resolved', tokens_in: 0, tokens_out: 0 })
  await post(B.token, { instance_id: B.instance, records: [other] })
  assert.equal((await sql('SELECT agent_id FROM task_outcomes WHERE id = $1', [other.id]))[0].agent_id, null)
})
