// Providers and gateways managed from the console, against PostgreSQL.
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
const { hashPassword } = await import('../lib/password.js')
const { closeDb } = await import('../lib/db.js')
const { testConnection, PRESETS, PROVIDERS } = await import('../lib/providers.js')
const { CATALOG } = await import('../lib/provider-catalog.js')
const { decryptSecret } = await import('../lib/secrets.js')
const { buildSyncResponse } = await import('../lib/sync.js')

const url = process.env.DATABASE_URL
const skip = url ? false : 'DATABASE_URL not set'
const PASSWORD = 'correct horse battery'
let db
const orgs = []

const mods = {}
async function call(path, method, { as, body, query = '', params = {} } = {}) {
  mods[path] ??= await import(`../app/api/${path}/route.js`)
  const headers = {}
  if (as) headers.cookie = `stratum_session=${as}`
  if (body !== undefined) headers['content-type'] = 'application/json'
  const req = new NextRequest(`http://console.test/api/${path}${query}`, {
    method, headers, body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const res = await mods[path][method](req, { params: Promise.resolve(params) })
  const text = await res.text()
  return { status: res.status, body: text ? JSON.parse(text) : null, res }
}

const sql = async (text, params = []) => (await db.query(text, params)).rows

async function org() {
  const id = randomUUID()
  orgs.push(id)
  await sql('INSERT INTO organizations (id, name) VALUES ($1, $2)', [id, `c-${id.slice(0, 8)}`])
  const hash = await hashPassword(PASSWORD)
  const cookies = {}
  for (const role of ['owner', 'auditor', 'team_manager']) {
    const [team] = role === 'team_manager'
      ? await sql(`INSERT INTO teams (org_id, name) VALUES ($1, 't') RETURNING id`, [id]) : [null]
    const email = `${role}-${id.slice(0, 8)}@example.com`
    await sql(`INSERT INTO users (org_id, team_id, email, role, password_hash) VALUES ($1, $2, $3, $4, $5)`,
      [id, team?.id ?? null, email, role, hash])
    const r = await call('session', 'POST', { body: { email, password: PASSWORD } })
    cookies[role] = r.res.cookies.get('stratum_session').value
    // Owners must set up a second factor first (test/mfa.test.mjs); here
    // their session counts as if they had.
    await sql('UPDATE console_sessions SET enrollment_only = false WHERE token_hash = $1',
      [createHash('sha256').update(cookies[role]).digest('hex')])
  }
  return { id, ...cookies }
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

// --- providers -------------------------------------------------------------

test('providers: credentials are stored encrypted and never returned', { skip }, async () => {
  const key = `sk-ant-${randomBytes(16).toString('hex')}`
  const r = await call('internal/providers', 'POST', { as: A.owner, body: { provider: 'anthropic', api_key: key } })
  assert.equal(r.status, 201)
  assert.equal(r.body.api_key_hint, `…${key.slice(-4)}`)
  assert.equal(r.body.display_name, 'Anthropic')
  assert.ok(!JSON.stringify(r.body).includes(key))
  const [row] = await sql('SELECT api_key_encrypted FROM provider_configs WHERE id = $1', [r.body.id])
  assert.ok(!row.api_key_encrypted.includes(key))
  assert.equal(decryptSecret(row.api_key_encrypted), key)

  const list = await call('internal/providers', 'GET', { as: A.auditor })
  assert.equal(list.status, 200)
  assert.ok(!JSON.stringify(list.body).includes(key) && !JSON.stringify(list.body).includes(row.api_key_encrypted))
  assert.ok(list.body.presets.some(p => p.id === 'anthropic'))

  // Gateways get it in the sync, decrypted.
  const client = await db.connect()
  try {
    const s = await buildSyncResponse(client, { orgId: A.id, sinceVersion: 0, syncIntervalS: 30, decrypt: decryptSecret, warn: () => {} })
    assert.equal(s.provider_configs.find(p => p.provider === 'anthropic').api_key, key)
  } finally {
    client.release()
  }

  const audit = await sql(`SELECT details::text AS d FROM audit_log WHERE org_id = $1 AND action LIKE 'provider.%'`, [A.id])
  assert.ok(audit.length > 0 && audit.every(a => !a.d.includes(key)))
})

test('providers: one per provider name; adding it again replaces it', { skip }, async () => {
  const first = await call('internal/providers', 'POST', { as: A.owner, body: { provider: 'openai', api_key: 'sk-first-000000000000' } })
  const second = await call('internal/providers', 'POST', { as: A.owner, body: { provider: 'openai', api_key: 'sk-second-00000000000', display_name: 'OpenAI prod' } })
  assert.equal(second.status, 200)
  assert.equal(second.body.id, first.body.id)
  assert.equal(second.body.display_name, 'OpenAI prod')
  assert.equal(second.body.api_key_hint, '…0000')
})

test('providers: names, addresses and keys are validated', { skip }, async () => {
  const bad = [
    [{ provider: 'nope', api_key: 'x' }, 'unknown provider'],
    [{ provider: 'custom-', base_url: 'http://x:1' }, 'empty custom name'],
    [{ provider: 'custom-Bad_Name', base_url: 'http://x:1' }, 'custom name format'],
    [{ provider: 'anthropic' }, 'key required'],
    [{ provider: 'anthropic', api_key: 'k', base_url: 'http://proxy.example' }, 'presets need https'],
    [{ provider: 'openai', api_key: 'k', base_url: 'https://u:p@proxy.example' }, 'no credentials in URLs'],
    [{ provider: 'ollama' }, 'ollama needs an address'],
    [{ provider: 'azure', api_key: 'k', base_url: 'https://x.openai.azure.com' }, 'azure needs api_version'],
    [{ provider: 'constructor', api_key: 'k', base_url: 'https://x.example' }, 'built-in property names'],
    [{ provider: '__proto__', api_key: 'k', base_url: 'https://x.example' }, 'built-in property names'],
    [{ provider: 'openai', api_key: 'k', base_url: 'https://proxy.example/v1?key=SECRET' }, 'no query strings in URLs'],
    [{ provider: 'openai', api_key: 'k', base_url: 'https://proxy.example/#x' }, 'no fragments in URLs'],
  ]
  for (const [body, why] of bad) {
    const r = await call('internal/providers', 'POST', { as: A.owner, body })
    assert.equal(r.status, 400, why)
  }
  const custom = await call('internal/providers', 'POST', { as: A.owner, body: { provider: 'custom-vllm', base_url: 'http://vllm.internal:8000/' } })
  assert.equal(custom.status, 201)
  assert.equal(custom.body.base_url, 'http://vllm.internal:8000')
  assert.equal(custom.body.api_key_hint, null)
  // A short credential is not shown at all, but the console knows there is one.
  const short = await call('internal/providers', 'POST', { as: A.owner, body: { provider: 'ollama', base_url: 'http://ollama:11434', api_key: 'mock' } })
  assert.equal(short.body.api_key_hint, '••••')
  assert.equal(custom.body.testable, false)
})

test('providers: edit, disable, replace the key, revoke; scoped to the organization', { skip }, async () => {
  const { body: pc } = await call('internal/providers', 'POST', { as: A.owner, body: { provider: 'mistral', api_key: 'mistral-key-0000aaaa' } })
  const q = `?id=${pc.id}`
  assert.equal((await call('internal/providers', 'PATCH', { as: A.owner, query: q, body: { enabled: false } })).body.enabled, false)
  const replaced = await call('internal/providers', 'PATCH', { as: A.owner, query: q, body: { api_key: 'mistral-key-0000bbbb' } })
  assert.equal(replaced.body.api_key_hint, '…bbbb')
  assert.equal((await call('internal/providers', 'PATCH', { as: A.owner, query: q, body: {} })).status, 400)
  // Another organization, and roles without the permission.
  assert.equal((await call('internal/providers', 'PATCH', { as: B.owner, query: q, body: { enabled: true } })).status, 404)
  assert.equal((await call('internal/providers', 'DELETE', { as: B.owner, query: q })).status, 404)
  assert.equal((await call('internal/providers', 'PATCH', { as: A.auditor, query: q, body: { enabled: true } })).status, 403)
  assert.equal((await call('internal/providers', 'GET', { as: A.team_manager })).status, 403)
  // Revoked: the credential is discarded and the configuration leaves the list.
  assert.equal((await call('internal/providers', 'DELETE', { as: A.owner, query: q })).status, 200)
  const [gone] = await sql('SELECT api_key_encrypted, api_key_hint FROM provider_configs WHERE id = $1', [pc.id])
  assert.deepEqual([gone.api_key_encrypted, gone.api_key_hint], ['', null])
  const list = (await call('internal/providers', 'GET', { as: A.owner })).body.providers
  assert.ok(!list.some(p => p.id === pc.id))
})

test('providers: the connection test only calls presets at their default address', { skip }, async () => {
  const { body: pc } = await call('internal/providers', 'POST', {
    as: A.owner, body: { provider: 'groq', api_key: 'gsk-0000000000000', base_url: 'https://proxy.example/groq' } })
  const r = await call('internal/providers/test', 'POST', { as: A.owner, body: { id: pc.id } })
  assert.equal(r.body.ok, false)
  assert.match(r.body.message, /gateway/)
  const typed = await call('internal/providers/test', 'POST', { as: A.owner, body: { provider: 'custom-x', api_key: 'k', base_url: 'http://169.254.169.254' } })
  assert.equal(typed.body.ok, false)
  assert.equal((await call('internal/providers/test', 'POST', { as: A.auditor, body: { id: pc.id } })).status, 403)
})

test('providers: a catalog provider stores its address, which gateways do not know', { skip }, async () => {
  const list = await call('internal/providers', 'GET', { as: A.owner })
  const cerebras = list.body.presets.find(p => p.id === 'cerebras')
  assert.deepEqual([cerebras?.category, cerebras?.testable], ['inference', true])
  assert.ok(list.body.presets.length > 80, 'presets and catalog')
  assert.equal(list.body.presets.find(p => p.id === 'anthropic').category, 'lab', 'presets keep their entry')

  const { status, body: pc } = await call('internal/providers', 'POST', { as: A.owner, body: { provider: 'cerebras', api_key: 'csk-0000aaaa' } })
  assert.equal(status, 201)
  assert.equal(pc.base_url, 'https://api.cerebras.ai/v1', 'stored, so it travels in the sync')
  assert.equal(pc.testable, true, 'still its own address')
  // Clearing the address goes back to the catalog's, not to nothing.
  const q = `?id=${pc.id}`
  await call('internal/providers', 'PATCH', { as: A.owner, query: q, body: { base_url: 'https://proxy.example/cerebras/v1' } })
  const proxied = (await call('internal/providers', 'GET', { as: A.owner })).body.providers.find(p => p.id === pc.id)
  assert.equal(proxied.testable, false, 'a typed address is tested from a gateway')
  const reset = await call('internal/providers', 'PATCH', { as: A.owner, query: q, body: { base_url: null } })
  assert.equal(reset.body.base_url, 'https://api.cerebras.ai/v1')
  // Presets the gateway knows still store no address.
  const { body: groq } = await call('internal/providers', 'POST', { as: A.owner, body: { provider: 'groq', api_key: 'gsk-0000bbbb' } })
  assert.equal(groq.base_url, null)
  await call('internal/providers', 'DELETE', { as: A.owner, query: q })
  await call('internal/providers', 'DELETE', { as: A.owner, query: `?id=${groq.id}` })
})

test('provider catalog: names, addresses and categories gateways can use', () => {
  const ids = new Set()
  for (const e of CATALOG) {
    assert.match(e.id, /^[a-z0-9][a-z0-9-]{0,38}$/, e.id)
    assert.ok(!e.id.startsWith('custom-'), e.id)
    assert.ok(!ids.has(e.id), `duplicate ${e.id}`); ids.add(e.id)
    assert.ok(e.label && e.label.length <= 60, e.id)
    assert.ok(['lab', 'inference', 'cloud', 'regional', 'router'].includes(e.category), e.id)
    const u = new URL(e.base)
    assert.equal(u.protocol, 'https:', e.id)
    assert.ok(!u.search && !u.hash && !u.username && !e.base.endsWith('/'), e.id)
    // The gateway drops the client's "v1/" only when the address has a version.
    assert.match(u.pathname, /\/v\d+[a-z]*(\/|$)/, `${e.id}: ${e.base}`)
    assert.ok(e.docs === null || e.docs.startsWith('https://'), e.id)
    assert.equal(typeof e.free, 'boolean', e.id)
  }
  for (const id of Object.keys(PRESETS)) assert.equal(PROVIDERS[id].stored, undefined, `${id} keeps the gateway's address`)
})

test('testConnection: headers per protocol, model count, refusals', async () => {
  const seen = []
  const fake = (status, body) => async (u, init) => {
    seen.push({ u, headers: init.headers })
    return new Response(JSON.stringify(body), { status })
  }
  const ok = await testConnection('anthropic', 'sk-ant-x', {
    fetchImpl: fake(200, { data: [{ id: 'claude-opus-5-5' }, { id: 'claude-haiku-4-5-20251001' }, {}] }) })
  assert.deepEqual([ok.ok, ok.models], [true, 3])
  assert.deepEqual(ok.ids, ['claude-opus-5-5', 'claude-haiku-4-5-20251001'], 'the IDs, for the model list')
  assert.equal(seen[0].u, 'https://api.anthropic.com/v1/models?limit=1000', 'one page with every model')
  assert.equal(seen[0].headers['x-api-key'], 'sk-ant-x')
  const denied = await testConnection('openai', 'sk-x', { fetchImpl: fake(401, { error: 'no' }) })
  assert.deepEqual([denied.ok, denied.status], [false, 401])
  assert.equal(seen[1].headers.authorization, 'Bearer sk-x')
  const gemini = await testConnection('gemini', 'k', { fetchImpl: fake(200, { data: [{ id: 'models/gemini-3.8-flash' }] }) })
  assert.deepEqual(gemini.ids, ['gemini-3.8-flash'], 'without the "models/" prefix')
  const native = await testConnection('gemini', 'k', { fetchImpl: fake(200, { models: [{ name: 'models/gemini-3.6-flash' }] }) })
  assert.deepEqual(native.ids, ['gemini-3.6-flash'])
  const none = await testConnection('ollama', 'x', { fetchImpl: fake(200, {}) })
  assert.equal(none.ok, false)
  assert.equal(seen.length, 4, 'ollama was not called')
  const cat = await testConnection('cerebras', 'csk', { fetchImpl: fake(200, { data: [{ id: 'llama-4' }] }) })
  assert.deepEqual(cat.ids, ['llama-4'])
  assert.equal(seen[4].u, 'https://api.cerebras.ai/v1/models', 'a catalog provider at its own address')
  assert.equal(seen[4].headers.authorization, 'Bearer csk')
})

// --- gateways ----------------------------------------------------------------

test('gateways: register shows the token once; rotate and disable', { skip }, async () => {
  const reg = await call('internal/instances', 'POST', { as: A.owner, body: { name: 'gw-test' } })
  assert.equal(reg.status, 201)
  const token = reg.body.sync_token
  const [row] = await sql('SELECT sync_token_hash FROM data_plane_instances WHERE id = $1', [reg.body.id])
  assert.equal(row.sync_token_hash, createHash('sha256').update(token).digest('hex'))

  const list = await call('internal/instances', 'GET', { as: A.auditor })
  const gw = list.body.instances.find(i => i.id === reg.body.id)
  assert.equal(gw.status, 'never')
  assert.ok(!JSON.stringify(list.body).includes(token) && !JSON.stringify(list.body).includes(row.sync_token_hash))
  assert.equal(typeof list.body.current_version, 'number')

  const rot = await call('internal/instances', 'PATCH', { as: A.owner, query: `?id=${reg.body.id}`, body: { action: 'rotate-token' } })
  assert.equal(rot.status, 200)
  assert.notEqual(rot.body.sync_token, token)
  const [after] = await sql('SELECT sync_token_hash FROM data_plane_instances WHERE id = $1', [reg.body.id])
  assert.equal(after.sync_token_hash, createHash('sha256').update(rot.body.sync_token).digest('hex'))

  assert.equal((await call('internal/instances', 'PATCH', { as: B.owner, query: `?id=${reg.body.id}`, body: { action: 'rotate-token' } })).status, 404)
  assert.equal((await call('internal/instances', 'POST', { as: A.auditor, body: { name: 'x' } })).status, 403)
  assert.equal((await call('internal/instances', 'DELETE', { as: A.owner, query: `?id=${reg.body.id}` })).status, 200)
  const disabled = (await call('internal/instances', 'GET', { as: A.owner })).body.instances.find(i => i.id === reg.body.id)
  assert.equal(disabled.status, 'disabled')
  // A disabled gateway cannot get a new token.
  assert.equal((await call('internal/instances', 'PATCH', { as: A.owner, query: `?id=${reg.body.id}`, body: { action: 'rotate-token' } })).status, 404)
})

// --- policies --------------------------------------------------------------

test('policies: providers and "all models" are set explicitly, and travel to gateways', { skip }, async () => {
  const created = await call('policies', 'POST', { as: A.owner, body: {
    name: 'Solo Haiku', allowedProviders: ['anthropic'], allowedModels: ['claude-haiku-4-5-20251001'] } })
  assert.equal(created.status, 201)
  assert.deepEqual(created.body.allowed_providers, ['anthropic'])
  assert.equal(created.body.allow_all_models, false)
  const id = created.body.id

  const all = await call('policies/[id]', 'PATCH', { as: A.owner, params: { id }, body: { allowAllModels: true, allowedProviders: null } })
  assert.equal(all.status, 200)
  assert.equal(all.body.allow_all_models, true)
  assert.equal(all.body.allowed_providers, null)
  assert.equal(all.body.name, 'Solo Haiku', 'fields not sent stay as they were')

  // A PATCH without allowedProviders leaves them alone.
  await call('policies/[id]', 'PATCH', { as: A.owner, params: { id }, body: { allowedProviders: ['anthropic', 'openai'] } })
  const kept = await call('policies/[id]', 'PATCH', { as: A.owner, params: { id }, body: { monthlyBudgetUsd: 5 } })
  assert.deepEqual(kept.body.allowed_providers, ['anthropic', 'openai'])

  for (const body of [{ allowedProviders: ['not-a-provider'] }, { allowedProviders: 'anthropic' }, { allowedProviders: [] }, { allowAllModels: 'yes' }]) {
    assert.equal((await call('policies/[id]', 'PATCH', { as: A.owner, params: { id }, body })).status, 400, JSON.stringify(body))
  }
  assert.equal((await call('policies/[id]', 'PATCH', { as: A.auditor, params: { id }, body: { allowAllModels: false } })).status, 403)
  assert.equal((await call('policies/[id]', 'PATCH', { as: B.owner, params: { id }, body: { allowAllModels: false } })).status, 404)
})

test('models: the catalog lists aliases', { skip }, async () => {
  const r = await call('models', 'GET', { as: A.auditor })
  assert.equal(r.status, 200)
  const haiku = r.body.find(m => m.model_id === 'claude-haiku-4-5-20251001')
  assert.deepEqual(haiku.aliases, ['claude-haiku-4-5'])
  assert.ok(!r.body.some(m => m.provider === 'google-gemini'), 'Gemini is listed as "gemini", like gateways call it')
})
