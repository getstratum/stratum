// Model aliases, "Rutas" in Modelos (lib/model-aliases.js, ADR-0015):
// through the real route handlers and the sync body, against PostgreSQL.
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
const { parseAlias, parseName } = await import('../lib/model-aliases.js')
const { buildSyncResponse } = await import('../lib/sync.js')

const url = process.env.DATABASE_URL
const skip = url ? false : 'DATABASE_URL not set'
const PASSWORD = 'correct horse battery'
let db
const orgs = []
const sql = async (text, params = []) => (await db.query(text, params)).rows

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

async function org() {
  const id = randomUUID()
  orgs.push(id)
  await sql('INSERT INTO organizations (id, name) VALUES ($1, $2)', [id, `a-${id.slice(0, 8)}`])
  const [team] = await sql(`INSERT INTO teams (org_id, name) VALUES ($1, 'Ingeniería') RETURNING id`, [id])
  for (const provider of ['openai', 'groq', 'anthropic']) {
    await sql(`INSERT INTO provider_configs (id, org_id, provider, display_name, api_key_encrypted, enabled)
               VALUES ($1, $2, $3, $3, 'x', true)`, [`pc_${provider}_${id.slice(0, 8)}`, id, provider])
  }
  const hash = await hashPassword(PASSWORD)
  const out = { id, team: team.id }
  for (const role of ['admin', 'auditor']) {
    const email = `${role}-${id.slice(0, 8)}@example.com`
    await sql(`INSERT INTO users (org_id, team_id, email, role, password_hash) VALUES ($1, $2, $3, $4, $5)`,
      [id, team.id, email, role, hash])
    const r = await (await import('../app/api/session/route.js')).POST(new NextRequest('http://console.test/api/session', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: PASSWORD }),
    }))
    const cookie = r.cookies.get('stratum_session').value
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

const rapido = { name: 'rapido', description: 'Respuestas cortas', targets: [
  { provider: 'openai', model: 'gpt-4o-mini' }, { provider: 'groq', model: 'llama-3.3-70b-versatile' }] }

test('a route: a name gateways accept, 1 to 4 models, one API format, none twice', () => {
  assert.equal(parseName(' Rapido '), 'rapido')
  for (const bad of ['', '-x', 'con espacio', 'x'.repeat(51), 'ñandú']) assert.throws(() => parseName(bad), bad)
  assert.deepEqual(parseAlias(rapido).targets, rapido.targets)
  const t = (provider, model) => ({ provider, model })
  for (const targets of [
    [], [t('openai', 'a'), t('openai', 'b'), t('openai', 'c'), t('openai', 'd'), t('openai', 'e')],
    [t('openai', 'a'), t('openai', 'a')], [t('anthropic', 'claude-haiku-4-5'), t('openai', 'gpt-4o')],
    [t('stratum', 'rapido')], [t('openai', '')],
  ]) assert.throws(() => parseAlias({ targets }), JSON.stringify(targets))
})

test('an Admin makes, changes and deletes a route; an Auditor only sees them', { skip }, async () => {
  assert.equal((await call('model-aliases', 'POST', { as: A.auditor, body: rapido })).status, 403)
  const made = await call('model-aliases', 'POST', { as: A.admin, body: rapido })
  assert.equal(made.status, 201, JSON.stringify(made.body))
  assert.equal((await call('model-aliases', 'POST', { as: A.admin, body: rapido })).status, 409, 'the name is taken')
  const list = await call('model-aliases', 'GET', { as: A.auditor })
  assert.equal(list.status, 200)
  assert.deepEqual(list.body.aliases.map(a => [a.name, a.targets.length]), [['rapido', 2]])
  assert.deepEqual((await call('model-aliases', 'GET', { as: B.admin })).body.aliases, [], 'another organization sees none')

  const changed = await call('model-aliases/[name]', 'PUT', { as: A.admin, params: { name: 'rapido' },
    body: { targets: [rapido.targets[1], rapido.targets[0]] } })
  assert.equal(changed.status, 200)
  assert.equal(changed.body.alias.targets[0].provider, 'groq')
  assert.equal((await call('model-aliases/[name]', 'PUT', { as: B.admin, params: { name: 'rapido' }, body: rapido })).status, 404)

  // A provider the organization did not connect.
  const off = await call('model-aliases', 'POST', { as: A.admin, body: { name: 'otro', targets: [{ provider: 'mistral', model: 'small' }] } })
  assert.equal(off.status, 400)
  assert.match(off.body.message, /mistral/)

  const audit = await sql(`SELECT action FROM audit_log WHERE org_id = $1 AND action LIKE 'model_alias.%' ORDER BY id`, [A.id])
  assert.deepEqual(audit.map(r => r.action), ['model_alias.create', 'model_alias.update'])
})

test('an agent can have a route as its fixed model; the route cannot go while it does', { skip }, async () => {
  const bad = await call('agents', 'POST', { as: A.admin, body: { name: 'bot', teamId: A.team, defaultProvider: 'stratum', defaultModel: 'lento' } })
  assert.equal(bad.status, 400, 'a route that does not exist')
  const ok = await call('agents', 'POST', { as: A.admin, body: { name: 'bot', teamId: A.team, defaultProvider: 'stratum', defaultModel: 'rapido' } })
  assert.equal(ok.status, 201, JSON.stringify(ok.body))
  const del = await call('model-aliases/[name]', 'DELETE', { as: A.admin, params: { name: 'rapido' } })
  assert.equal(del.status, 409)
  assert.match(del.body.message, /bot/)
  await call('agents/[id]', 'PATCH', { as: A.admin, params: { id: ok.body.agent.id }, body: { defaultProvider: null, defaultModel: null } })
  assert.equal((await call('model-aliases/[name]', 'DELETE', { as: A.admin, params: { name: 'rapido' } })).status, 200)
})

test('gateways get the whole list with every sync, a delta too', { skip }, async () => {
  await call('model-aliases', 'POST', { as: B.admin, body: rapido })
  const client = await db.connect()
  try {
    for (const since of [0, 999999999]) {
      const body = JSON.parse(JSON.stringify(await buildSyncResponse(client, {
        orgId: B.id, sinceVersion: since, syncIntervalS: 30, decrypt: v => v, warn: () => {},
      })))
      assert.deepEqual(body.model_aliases, [{ name: 'rapido', targets: rapido.targets }], `since ${since}`)
    }
    const none = JSON.parse(JSON.stringify(await buildSyncResponse(client, {
      orgId: A.id, sinceVersion: 0, syncIntervalS: 30, decrypt: v => v, warn: () => {},
    })))
    assert.deepEqual(none.model_aliases, [], 'an empty list, so a gateway drops the ones it had')
  } finally {
    client.release()
  }
})
