// MCP servers and the tools a policy allows (lib/mcp.js, migration 040,
// ADR-0016): through the real route handlers and the sync body.
//
//   DATABASE_URL=postgres://... node --import ./test/register.mjs --test test/
//
// Database tests are skipped without DATABASE_URL.

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID, randomBytes, createHash } from 'node:crypto'

process.env.STRATUM_ENCRYPTION_KEY ??= randomBytes(32).toString('hex')
const { NextRequest } = await import('next/server.js')
const pg = (await import('pg')).default
const { hashPassword } = await import('../lib/password.js')
const { closeDb } = await import('../lib/db.js')
const { decryptSecret } = await import('../lib/secrets.js')
const { buildSyncResponse } = await import('../lib/sync.js')
const { serverFields, mcpToolsField, toolAllowed, catalogReport } = await import('../lib/mcp.js')

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
  await sql('INSERT INTO organizations (id, name) VALUES ($1, $2)', [id, `mcp-${id.slice(0, 8)}`])
  const [team] = await sql(`INSERT INTO teams (org_id, name) VALUES ($1, 'Soporte') RETURNING id`, [id])
  const hash = await hashPassword(PASSWORD)
  const out = { id, team: team.id }
  for (const role of ['admin', 'auditor']) {
    const email = `${role}-${id.slice(0, 8)}@example.com`
    await sql(`INSERT INTO users (org_id, team_id, email, role, password_hash) VALUES ($1, $2, $3, $4, $5)`, [id, team.id, email, role, hash])
    const r = await (await import('../app/api/session/route.js')).POST(new NextRequest('http://console.test/api/session', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: PASSWORD }),
    }))
    const cookie = r.cookies.get('stratum_session').value
    await sql('UPDATE console_sessions SET enrollment_only = false WHERE token_hash = $1', [createHash('sha256').update(cookie).digest('hex')])
    out[role] = cookie
  }
  return out
}

let A
before(async () => {
  if (!url) return
  db = new pg.Pool({ connectionString: url, max: 2 })
  A = await org()
})
after(async () => {
  if (!db) return
  await sql('DELETE FROM organizations WHERE id = ANY($1::uuid[])', [orgs])
  await db.end()
  await closeDb()
})

test('serverFields and mcpToolsField: what is accepted', () => {
  assert.deepEqual(serverFields({ name: 'tickets', url: 'http://mcp.svc:8080/mcp', authHeader: 'X-API-Key', secret: ' k ' }, { create: true }),
    { name: 'tickets', url: 'http://mcp.svc:8080/mcp', authHeader: 'X-API-Key', secret: 'k' })
  assert.throws(() => serverFields({ name: 'Tickets', url: 'https://x' }, { create: true }), /Nombre/)
  assert.throws(() => serverFields({ name: 'a', url: 'ftp://x' }, { create: true }), /http/)
  assert.throws(() => serverFields({ name: 'a', url: 'https://u:p@x' }, { create: true }), /credenciales/)
  assert.throws(() => serverFields({ authHeader: 'Mcp-Session-Id' }), /Encabezado/)
  assert.throws(() => serverFields({ secret: 'a\r\nInjected: 1' }), /Valor/)
  assert.deepEqual(mcpToolsField(['wiki/buscar', 'tickets/*', 'wiki/buscar']), ['tickets/*', 'wiki/buscar'])
  assert.throws(() => mcpToolsField(['tickets']), /servidor/)
  assert.ok(toolAllowed(['tickets/*'], 'tickets', 'crear'))
  assert.ok(!toolAllowed(['wiki/buscar'], 'wiki', 'editar'))
})

test('mcp servers: kept with their credential encrypted, never shown; gateways get them; policies allow their tools', { skip }, async () => {
  assert.equal((await call('mcp-servers', 'POST', { as: A.auditor, body: { name: 'x', url: 'https://x' } })).status, 403)
  assert.equal((await call('mcp-servers', 'POST', { as: A.admin, body: { name: 'x', url: 'https://x', secret: 'k' } })).status, 400,
    'a credential needs its header')
  const created = await call('mcp-servers', 'POST', { as: A.admin, body: {
    name: 'tickets', description: 'Soporte', url: 'https://mcp.tickets.test/mcp', authHeader: 'Authorization', secret: 'Bearer tk_secret_123456' } })
  assert.equal(created.status, 201)
  assert.equal(created.body.server.secret_hint, '…3456')
  assert.equal(JSON.stringify(created.body).includes('tk_secret'), false)
  assert.equal((await call('mcp-servers', 'POST', { as: A.admin, body: { name: 'tickets', url: 'https://otro' } })).status, 409)
  const [row] = await sql('SELECT secret_encrypted FROM mcp_servers WHERE org_id = $1', [A.id])
  assert.equal(decryptSecret(row.secret_encrypted), 'Bearer tk_secret_123456')
  await call('mcp-servers', 'POST', { as: A.admin, body: { name: 'wiki', url: 'http://wiki.svc:8080/mcp', enabled: false } })

  // A policy with tools of one server.
  const pol = await call('policies', 'POST', { as: A.admin, body: { name: 'Soporte', allowAllModels: true, mcpTools: ['tickets/buscar', 'tickets/crear'] } })
  assert.equal(pol.status, 201)
  assert.deepEqual(pol.body.mcp_tools, ['tickets/buscar', 'tickets/crear'])
  await sql('UPDATE teams SET policy_id = $1 WHERE id = $2', [pol.body.id, A.team])
  assert.equal((await call('policies', 'POST', { as: A.admin, body: { name: 'x', allowAllModels: true, mcpTools: ['nada'] } })).status, 400)

  const list = (await call('mcp-servers', 'GET', { as: A.auditor })).body.servers
  assert.deepEqual(list.map(s => [s.name, s.enabled, s.policies]), [['tickets', true, ['Soporte']], ['wiki', false, []]])

  // Gateways: the servers turned on, with the header; the policy's tools.
  const client = await db.connect()
  try {
    const sync = JSON.parse(JSON.stringify(await buildSyncResponse(client, {
      orgId: A.id, sinceVersion: 0, syncIntervalS: 30, decrypt: decryptSecret, warn: () => {} })))
    assert.deepEqual(sync.mcp_servers, [{ name: 'tickets', url: 'https://mcp.tickets.test/mcp', headers: { Authorization: 'Bearer tk_secret_123456' }, description: 'Soporte' }])
    assert.deepEqual(sync.policies.find(p => p.team_id === A.team).mcp_tools, ['tickets/buscar', 'tickets/crear'])
  } finally {
    client.release()
  }

  // Edits: the name stays; an empty credential keeps the one kept.
  const id = created.body.server.id
  assert.equal((await call('mcp-servers/[id]', 'PATCH', { as: A.admin, params: { id }, body: { name: 'otro' } })).status, 400)
  const edited = await call('mcp-servers/[id]', 'PATCH', { as: A.admin, params: { id }, body: { url: 'https://mcp2.tickets.test/mcp' } })
  assert.deepEqual([edited.status, edited.body.server.secret_hint], [200, '…3456'])
  // Allowed by a policy: not deleted.
  const del = await call('mcp-servers/[id]', 'DELETE', { as: A.admin, params: { id } })
  assert.equal(del.status, 409)
  assert.match(del.body.message, /Soporte/)
  await call('policies/[id]', 'PATCH', { as: A.admin, params: { id: pol.body.id }, body: { mcpTools: [] } })
  assert.equal((await call('mcp-servers/[id]', 'DELETE', { as: A.admin, params: { id } })).status, 200)
})

test('catalogReport: what a gateway may report', () => {
  assert.throws(() => catalogReport({ servers: 'x' }), /servers/)
  assert.deepEqual(catalogReport({ servers: [
    { name: 'demo', tools: [{ name: 'hora', description: 'La hora', read_only: true }, { name: '' }, { name: 'x'.repeat(200) }, { name: 'borrar', read_only: 'si' }] },
    { name: 'No Vale', tools: [] },
    { name: 'caido', tools: null, error: 'initialize: the server could not be reached' },
  ] }), [
    { name: 'demo', tools: [{ name: 'hora', description: 'La hora', read_only: true }, { name: 'borrar', description: '', read_only: false }], error: null },
    { name: 'caido', tools: [], error: 'initialize: the server could not be reached' },
  ])
})

test('what each server offers: a gateway reports it with its sync token; the list shows it, only for its organization', { skip }, async () => {
  const B = await org()
  for (const o of [A, B]) await sql(`INSERT INTO mcp_servers (id, org_id, name, url) VALUES ($1, $2, 'demo', 'http://mock:8080/mcp')`, [`mcp_${randomBytes(8).toString('hex')}`, o.id])
  await sql(`INSERT INTO mcp_servers (id, org_id, name, url) VALUES ($1, $2, 'caido', 'http://nadie:1/mcp')`, [`mcp_${randomBytes(8).toString('hex')}`, A.id])
  const token = randomBytes(16).toString('hex')
  const gw = `dp_${randomBytes(8).toString('hex')}`
  await sql(`INSERT INTO data_plane_instances (id, org_id, name, sync_token_hash) VALUES ($1, $2, 'gw', $3)`,
    [gw, A.id, createHash('sha256').update(token).digest('hex')])
  const report = async (body, auth = `Bearer ${token}`) => {
    const { POST } = await import('../app/api/internal/mcp-catalog/route.js')
    const res = await POST(new NextRequest('http://console.test/api/internal/mcp-catalog', {
      method: 'POST', headers: { authorization: auth, 'content-type': 'application/json' }, body: JSON.stringify(body) }))
    return { status: res.status, body: await res.json() }
  }
  const body = { instance_id: gw, servers: [
    { name: 'demo', tools: [{ name: 'clima', description: 'El clima' }, { name: 'hora', read_only: true }] },
    { name: 'caido', tools: [], error: 'initialize: the server could not be reached' },
    { name: 'ajeno', tools: [{ name: 'x' }] },
  ] }
  assert.equal((await report(body, 'Bearer otro')).status, 401)
  assert.equal((await report({ ...body, instance_id: 'dp_otro' })).status, 403)
  assert.equal((await report({ servers: 'x' })).status, 400)
  assert.deepEqual((await report(body)).body, { updated: 2 }, 'its organization\'s servers only')

  const list = (await call('mcp-servers', 'GET', { as: A.auditor })).body.servers
  const demo = list.find(s => s.name === 'demo')
  assert.deepEqual(demo.tools, [{ name: 'clima', description: 'El clima', read_only: false }, { name: 'hora', description: '', read_only: true }])
  assert.equal(demo.tools_error, null)
  assert.ok(demo.tools_at)
  assert.equal(list.find(s => s.name === 'caido').tools_error, 'initialize: the server could not be reached')
  const other = (await call('mcp-servers', 'GET', { as: B.auditor })).body.servers
  assert.equal(other.find(s => s.name === 'demo').tools, null, 'another organization\'s server is untouched')
})
