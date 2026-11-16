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
const { serverFields, mcpToolsField, toolAllowed } = await import('../lib/mcp.js')

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
