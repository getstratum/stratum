// The live model catalog (ADR-0012, migration 024): the feed, and what each
// organization turns off or prices.
//
//   DATABASE_URL=postgres://... node --import ./test/register.mjs --test test/
//
// Feed tests only touch models of their own provider, so they can run next
// to the other test files on the same database.

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID, randomBytes, createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

const { NextRequest } = await import('next/server.js')
const pg = (await import('pg')).default
const { hashPassword } = await import('../lib/password.js')
const { closeDb } = await import('../lib/db.js')
const { parseFeed, applyFeed, refreshCatalog, feedUrl, DEFAULT_FEED_URL } = await import('../lib/model-feed.js')
const { buildSyncResponse } = await import('../lib/sync.js')
const { hashSyncToken } = await import('../lib/instance-auth.js')

const url = process.env.DATABASE_URL
const skip = url ? false : 'DATABASE_URL not set'
const PASSWORD = 'correct horse battery'
const P = `feedtest-${randomBytes(3).toString('hex')}` // this run's provider
let db
const orgs = []
const sql = async (text, params = []) => (await db.query(text, params)).rows

const mods = {}
async function call(path, method, { as, body, query = '' } = {}) {
  mods[path] ??= await import(`../app/api/${path}/route.js`)
  const headers = {}
  if (as) headers.cookie = `stratum_session=${as}`
  if (body !== undefined) headers['content-type'] = 'application/json'
  const req = new NextRequest(`http://console.test/api/${path}${query}`, {
    method, headers, body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const res = await mods[path][method](req, { params: Promise.resolve({}) })
  const text = await res.text()
  return { status: res.status, body: text ? JSON.parse(text) : null, res }
}

async function org() {
  const id = randomUUID()
  orgs.push(id)
  await sql('INSERT INTO organizations (id, name) VALUES ($1, $2)', [id, `m-${id.slice(0, 8)}`])
  const hash = await hashPassword(PASSWORD)
  const cookies = {}
  for (const role of ['owner', 'auditor']) {
    const email = `${role}-${id.slice(0, 8)}@example.com`
    await sql(`INSERT INTO users (org_id, email, role, password_hash) VALUES ($1, $2, $3, $4)`, [id, email, role, hash])
    const r = await call('session', 'POST', { body: { email, password: PASSWORD } })
    cookies[role] = r.res.cookies.get('stratum_session').value
    await sql('UPDATE console_sessions SET enrollment_only = false WHERE token_hash = $1',
      [createHash('sha256').update(cookies[role]).digest('hex')])
  }
  const [pol] = await sql(
    `INSERT INTO policies (org_id, name, allowed_models, allow_all_models) VALUES ($1, 'all', '{}', true) RETURNING id`, [id])
  const [team] = await sql(`INSERT INTO teams (org_id, name, policy_id) VALUES ($1, 'Eng', $2) RETURNING id`, [id, pol.id])
  return { id, team: team.id, policy: pol.id, ...cookies }
}

async function sync(orgId) {
  const client = await db.connect()
  try {
    return JSON.parse(JSON.stringify(await buildSyncResponse(client, {
      orgId, sinceVersion: 0, syncIntervalS: 30, decrypt: v => v, warn: () => {},
    })))
  } finally {
    client.release()
  }
}

const feed = (models, extra = {}) => ({ schema: 1, updated: '2026-10-18', models, ...extra })
const model = (id, extra = {}) => ({ provider: P, id, name: id, aliases: [], input_per_mtok: 1, output_per_mtok: 2, ...extra })

let A, B
before(async () => {
  if (!url) return
  db = new pg.Pool({ connectionString: url, max: 3 })
  A = await org()
  B = await org()
})

after(async () => {
  if (!db) return
  await sql('DELETE FROM organizations WHERE id = ANY($1::uuid[])', [orgs])
  await sql('DELETE FROM ai_models WHERE provider = $1', [P])
  await db.end()
  await closeDb()
})

test('feed: the repository catalog is a valid feed', () => {
  const parsed = parseFeed(JSON.parse(readFileSync(new URL('../../../catalog/models.json', import.meta.url), 'utf8')))
  assert.ok(parsed.models.length >= 20)
  assert.ok(parsed.models.every(m => m.input >= 0 && m.output >= 0))
})

test('feed: anything malformed rejects the whole feed', () => {
  const bad = [
    [null, 'not an object'],
    [{ ...feed([model('a')]), schema: 2 }, 'unknown schema'],
    [feed([]), 'no models'],
    [feed([model('a')], { updated: 'yesterday' }), 'bad date'],
    [feed([{ ...model('a'), provider: 'Bad Provider' }]), 'provider name'],
    [feed([{ ...model('a'), id: 'has space' }]), 'model id'],
    [feed([model('a', { input_per_mtok: -1 })]), 'negative price'],
    [feed([model('a', { output_per_mtok: '2' })]), 'price as text'],
    [feed([model('a'), model('a')]), 'duplicate id'],
    [feed([model('a'), model('b', { aliases: ['a'] })]), 'alias of another model'],
    [feed([model('a', { deprecated_on: '18/10/2026' })]), 'deprecation date'],
    [feed([model('a', { retired: 'yes' })]), 'retired flag'],
  ]
  for (const [f, why] of bad) assert.throws(() => parseFeed(f), /./, why)
})

test('feed: adds and updates, never deletes; IDs reach policies, prices do not', { skip }, async () => {
  const [pol] = await sql(
    `INSERT INTO policies (org_id, name, allowed_models) VALUES ($1, 'named', ARRAY[$2]) RETURNING id, version`,
    [A.id, `${P}/one`])
  const version = async () => Number((await sql('SELECT version FROM policies WHERE id = $1', [pol.id]))[0].version)

  let r = await applyFeed(db, parseFeed(feed([model('one'), model('two')])), { source: 'test' })
  assert.deepEqual([r.applied, r.changed], [true, 2])
  const v1 = await version()

  // A price change: stored, and no policy version.
  r = await applyFeed(db, parseFeed(feed([model('one', { input_per_mtok: 3 }), model('two')])), { source: 'test' })
  assert.equal(r.changed, 1)
  assert.equal((await sql('SELECT cost_per_1k_input_tokens FROM ai_models WHERE provider = $1 AND model_id = $2', [P, 'one']))[0].cost_per_1k_input_tokens, '0.003000')
  assert.equal(await version(), v1, 'a price allows nothing new')

  // A new alias: the policy naming the model gets a new version.
  r = await applyFeed(db, parseFeed(feed([model('one', { input_per_mtok: 3, aliases: ['one-2026'] }), model('two')])), { source: 'test' })
  assert.equal(r.changed, 1)
  assert.ok(await version() > v1)

  // Missing from the feed: kept. Retired: no longer offered.
  r = await applyFeed(db, parseFeed(feed([model('two', { retired: true, deprecated_on: '2026-12-31' })])), { source: 'test' })
  const rows = await sql('SELECT model_id, is_active, deprecated_on::text AS d FROM ai_models WHERE provider = $1 ORDER BY 1', [P])
  assert.deepEqual(rows.map(x => [x.model_id, x.is_active, x.d]), [['one', true, null], ['two', false, '2026-12-31']])

  // The same feed again changes nothing.
  r = await applyFeed(db, parseFeed(feed([model('two', { retired: true, deprecated_on: '2026-12-31' })])), { source: 'test' })
  assert.equal(r.changed, 0)
  await sql('DELETE FROM policies WHERE id = $1', [pol.id])
})

test('feed: a fetch that fails or a feed that is not valid leaves the catalog as it was', { skip }, async () => {
  const before = await sql('SELECT count(*)::int AS n FROM ai_models')
  const fake = (status, body, headers = {}) => async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers })
  let r = await refreshCatalog(db, { url: 'http://example.com/models.json', fetchImpl: fake(200, feed([model('x')])) })
  assert.equal(r.ok, false, 'only https')
  r = await refreshCatalog(db, { url: 'https://example.com/models.json', fetchImpl: fake(500, 'no') })
  assert.deepEqual([r.ok, r.message], [false, 'the feed answered 500'])
  assert.equal((await sql('SELECT error FROM model_catalog_state'))[0].error, 'the feed answered 500', 'shown in the console')
  r = await refreshCatalog(db, { url: 'https://example.com/models.json', fetchImpl: fake(200, 'not json') })
  assert.equal(r.ok, false)
  r = await refreshCatalog(db, { url: 'https://example.com/models.json', fetchImpl: fake(200, feed([model('x', { input_per_mtok: -5 })])) })
  assert.equal(r.ok, false)
  r = await refreshCatalog(db, { url: 'https://example.com/models.json', fetchImpl: fake(200, 'x'.repeat(3 * 1024 * 1024)) })
  assert.match(r.message, /2 MB/)
  assert.deepEqual(await sql('SELECT count(*)::int AS n FROM ai_models'), before)

  r = await refreshCatalog(db, { url: 'https://example.com/models.json', fetchImpl: fake(200, feed([model('three')])) })
  assert.deepEqual([r.ok, r.changed], [true, 1])
  assert.equal((await sql('SELECT error FROM model_catalog_state'))[0].error, null)

  assert.equal(feedUrl({}), DEFAULT_FEED_URL)
  assert.equal(feedUrl({ STRATUM_MODEL_CATALOG_URL: 'off' }), null)
  assert.equal(feedUrl({ STRATUM_MODEL_CATALOG_URL: 'https://mirror.internal/models.json' }), 'https://mirror.internal/models.json')
})

test('models: an organization turns a model off; gateways refuse it, by any of its names', { skip }, async () => {
  await applyFeed(db, parseFeed(feed([model('off-me', { aliases: ['off-me-latest'] }), model('keep-me')])), { source: 'test' })
  const v0 = Number((await sql('SELECT version FROM policies WHERE id = $1', [A.policy]))[0].version)

  const r = await call('models', 'PATCH', { as: A.owner, body: { provider: P, model_id: 'off-me', enabled: false } })
  assert.equal(r.status, 200)
  assert.equal(r.body.enabled, false)
  const pol = (await sync(A.id)).policies.find(p => p.team_id === A.team)
  assert.deepEqual(pol.denied_models, [`${P}/off-me`, `${P}/off-me-latest`])
  assert.ok(pol.version > v0, 'a new version, so gateways get it in the next delta')
  assert.deepEqual((await sync(B.id)).policies.find(p => p.team_id === B.team).denied_models, [], 'another organization is not affected')

  const list = (await call('models', 'GET', { as: A.owner })).body
  assert.equal(list.find(m => m.provider === P && m.model_id === 'off-me').enabled, false)
  assert.equal((await call('models', 'GET', { as: B.owner })).body.find(m => m.provider === P && m.model_id === 'off-me').enabled, true)

  // On again.
  await call('models', 'PATCH', { as: A.owner, body: { provider: P, model_id: 'off-me', enabled: true } })
  assert.deepEqual((await sync(A.id)).policies.find(p => p.team_id === A.team).denied_models, [])

  // Who may, and what.
  assert.equal((await call('models', 'PATCH', { as: A.auditor, body: { provider: P, model_id: 'keep-me', enabled: false } })).status, 403)
  assert.equal((await call('models', 'PATCH', { as: A.owner, body: { provider: P, model_id: 'not-there', enabled: false } })).status, 400)
  assert.equal((await call('models', 'PATCH', { as: A.owner, body: { provider: P, model_id: 'keep-me' } })).status, 400)
  assert.equal((await call('models', 'PATCH', { as: A.owner, body: { provider: P, model_id: 'keep-me', input_per_mtok: -1 } })).status, 400)
})

test('models: an organization\'s own prices cost its usage; a provider\'s models outside the catalog can be priced', { skip }, async () => {
  await applyFeed(db, parseFeed(feed([model('priced', { input_per_mtok: 10, output_per_mtok: 20 })])), { source: 'test' })
  await sql(`INSERT INTO provider_models (org_id, provider, model_id) VALUES ($1, $2, 'only-at-the-provider')`, [A.id, P])
  const listed = (await call('models', 'GET', { as: A.owner })).body.find(m => m.model_id === 'only-at-the-provider')
  assert.deepEqual([listed?.source, listed?.cost_per_1k_input_tokens], ['provider', null])
  assert.equal((await call('models', 'GET', { as: B.owner })).body.find(m => m.model_id === 'only-at-the-provider'), undefined)

  assert.equal((await call('models', 'PATCH', { as: A.owner, body: { provider: P, model_id: 'priced', input_per_mtok: 5, output_per_mtok: 5 } })).status, 200)
  assert.equal((await call('models', 'PATCH', { as: A.owner, body: { provider: P, model_id: 'only-at-the-provider', input_per_mtok: 1, output_per_mtok: 1 } })).status, 200)

  // Usage reported by A's gateway: 1,000,000 tokens in and out.
  const token = `dp_sync_${randomBytes(32).toString('hex')}`
  const instance = `dp_${randomBytes(16).toString('hex')}`
  await sql('INSERT INTO data_plane_instances (id, org_id, name, sync_token_hash) VALUES ($1, $2, $3, $4)', [instance, A.id, 'gw', hashSyncToken(token)])
  const usage = await import('../app/api/internal/usage/route.js')
  const rec = m => ({ id: randomUUID(), ts: new Date().toISOString(), request_id: 'r', key_id: 'someone', team_id: A.team,
    provider: P, model: m, status: 200, reason: 'ok', stream: false, duration_ms: 1, upstream_ms: 1, tokens_in: 1000000, tokens_out: 1000000 })
  const records = [rec('priced'), rec('only-at-the-provider')]
  const res = await usage.POST(new NextRequest('http://console.test/api/internal/usage', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ instance_id: instance, records }),
  }), { params: Promise.resolve({}) })
  assert.equal(res.status, 200)
  const costs = await sql('SELECT model_id, cost_usd::text AS c FROM request_logs WHERE org_id = $1 AND provider = $2 ORDER BY 1', [A.id, P])
  assert.deepEqual(costs.map(x => [x.model_id, x.c]), [['only-at-the-provider', '2.000000'], ['priced', '10.000000']],
    'the organization\'s 5 + 5 per million, not the list 10 + 20; and the price it set for a model outside the catalog')
  await sql('DELETE FROM request_logs WHERE org_id = $1', [A.id])
})

test('models: the catalog feed state, and checking it now', { skip }, async () => {
  const s = await call('models/catalog', 'GET', { as: A.auditor })
  assert.equal(s.status, 200)
  assert.ok('feed_url' in s.body && 'applied_at' in s.body)
  assert.equal((await call('models/catalog', 'POST', { as: A.auditor })).status, 403)
})
