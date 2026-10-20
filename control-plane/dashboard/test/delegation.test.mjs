// Keys that act on behalf of people (migration 028): the agent flag, the
// people directory in the sync, a person's access to applications, and
// usage reported for a person through an agent.
//
//   DATABASE_URL=postgres://... node --import ./test/register.mjs --test test/
//
// Skipped without DATABASE_URL.

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID, randomBytes, createHash } from 'node:crypto'

const { NextRequest } = await import('next/server.js')
const pg = (await import('pg')).default
const { hashPassword } = await import('../lib/password.js')
const { closeDb } = await import('../lib/db.js')
const { buildSyncResponse } = await import('../lib/sync.js')
const { hashSyncToken } = await import('../lib/instance-auth.js')

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
  return { status: res.status, body: text ? JSON.parse(text) : null, res }
}

const sql = async (text, params = []) => (await db.query(text, params)).rows

async function sync(orgId, since) {
  const client = await db.connect()
  try {
    return JSON.parse(JSON.stringify(await buildSyncResponse(client, {
      orgId, sinceVersion: since, syncIntervalS: 30, decrypt: v => v, warn: () => {},
    })))
  } finally {
    client.release()
  }
}

// An organization with two teams, an owner, a team manager of Eng, a member
// of Sales and a registered gateway.
async function org() {
  const id = randomUUID()
  orgs.push(id)
  await sql('INSERT INTO organizations (id, name) VALUES ($1, $2)', [id, `d-${id.slice(0, 8)}`])
  const [eng] = await sql(`INSERT INTO teams (org_id, name) VALUES ($1, 'Eng') RETURNING id`, [id])
  const [sales] = await sql(`INSERT INTO teams (org_id, name) VALUES ($1, 'Sales') RETURNING id`, [id])
  const hash = await hashPassword(PASSWORD)
  const cookies = {}
  for (const [role, team] of [['owner', null], ['team_manager', eng.id]]) {
    const email = `${role}-${id.slice(0, 8)}@example.com`
    await sql(`INSERT INTO users (org_id, team_id, email, role, password_hash) VALUES ($1, $2, $3, $4, $5)`,
      [id, team, email, role, hash])
    const r = await call('session', 'POST', { body: { email, password: PASSWORD } })
    cookies[role] = r.res.cookies.get('stratum_session').value
    await sql('UPDATE console_sessions SET enrollment_only = false WHERE token_hash = $1',
      [createHash('sha256').update(cookies[role]).digest('hex')])
  }
  const [member] = await sql(`INSERT INTO users (org_id, team_id, email, role) VALUES ($1, $2, $3, 'member') RETURNING id`,
    [id, sales.id, `ana-${id.slice(0, 8)}@example.com`])
  const token = `dp_sync_${randomBytes(32).toString('hex')}`
  const instance = `dp_${randomBytes(16).toString('hex')}`
  await sql('INSERT INTO data_plane_instances (id, org_id, name, sync_token_hash) VALUES ($1, $2, $3, $4)',
    [instance, id, 'gw', hashSyncToken(token)])
  return { id, eng: eng.id, sales: sales.id, member: member.id, token, instance, ...cookies }
}

let A

before(async () => {
  if (!url) return
  db = new pg.Pool({ connectionString: url, max: 2 })
  A = await org()
})

after(async () => {
  if (!db) return
  await sql('DELETE FROM request_logs WHERE org_id = ANY($1::uuid[])', [orgs])
  await sql('DELETE FROM organizations WHERE id = ANY($1::uuid[])', [orgs])
  await sql('DELETE FROM stratum_sync_tombstones WHERE org_id = ANY($1::uuid[])', [orgs])
  await db.end()
  await closeDb()
})

test('delegation: only an organization-wide role makes an agent act for people', { skip }, async () => {
  const byManager = await call('agents', 'POST', { as: A.team_manager, body: { name: 'portal', teamId: A.eng, delegates: true } })
  assert.equal(byManager.status, 403)

  const r = await call('agents', 'POST', { as: A.owner, body: { name: 'portal', teamId: A.eng, delegates: true } })
  assert.equal(r.status, 201)
  assert.equal(r.body.agent.delegates, true)
  const id = r.body.agent.id

  // A team manager can edit the agent of their team, but not grant or keep
  // granting delegation; turning it off is allowed.
  assert.equal((await call('agents/[id]', 'PATCH', { as: A.team_manager, params: { id }, body: { delegates: true } })).status, 403)
  assert.equal((await call('agents/[id]', 'PATCH', { as: A.team_manager, params: { id }, body: { delegates: 'yes' } })).status, 400)

  const [{ v: before }] = await sql('SELECT key_version AS v FROM agents WHERE id = $1', [id])
  const off = await call('agents/[id]', 'PATCH', { as: A.team_manager, params: { id }, body: { delegates: false } })
  assert.equal(off.status, 200)
  assert.equal(off.body.delegates, false)
  const [{ v: after }] = await sql('SELECT key_version AS v FROM agents WHERE id = $1', [id])
  assert.ok(Number(after) > Number(before), 'turning delegation off is a new version of the key')

  const [log] = await sql(`SELECT details FROM audit_log WHERE org_id = $1 AND action = 'agent.create'`, [A.id])
  assert.equal(log.details.delegates, true)
})

test('delegation: the sync sends the flag with the key and the people directory', { skip }, async () => {
  const r = await call('agents', 'POST', { as: A.owner, body: { name: 'chat', teamId: A.eng, delegates: true } })
  const full = await sync(A.id, 0)
  const k = full.api_keys.find(x => x.id === `agent:${r.body.agent.id}`)
  assert.equal(k.delegates, true)
  assert.ok(full.api_keys.filter(x => !x.id.startsWith('agent:')).every(x => x.delegates === false))

  const ana = full.people.find(p => p.id === A.member)
  assert.deepEqual({ team_id: ana.team_id, revoked: ana.revoked }, { team_id: A.sales, revoked: false })
  assert.equal(typeof ana.version, 'number')
  assert.ok(full.people.every(p => Object.keys(p).sort().join() === 'id,revoked,team_id,version'),
    'ids and teams only: no names or emails')

  // Each change reaches gateways in a delta.
  const steps = [
    [{ appAccess: false }, { team_id: A.sales, revoked: true }],
    [{ appAccess: true }, { team_id: A.sales, revoked: false }],
    [{ teamId: A.eng }, { team_id: A.eng, revoked: false }],
    [{ isActive: false }, { team_id: A.eng, revoked: true }],
  ]
  let since = full.current_version
  for (const [body, want] of steps) {
    const res = await call('users/[id]', 'PATCH', { as: A.owner, params: { id: A.member }, body })
    assert.equal(res.status, 200, JSON.stringify(res.body))
    const delta = await sync(A.id, since)
    const p = delta.people.find(x => x.id === A.member)
    assert.ok(p, `${JSON.stringify(body)} is in the delta`)
    assert.deepEqual({ team_id: p.team_id, revoked: p.revoked }, want, JSON.stringify(body))
    since = delta.current_version
  }
  const [{ app_access }] = await sql('SELECT app_access FROM users WHERE id = $1', [A.member])
  assert.equal(app_access, true)
  const [log] = await sql(`SELECT details FROM audit_log WHERE org_id = $1 AND action = 'user.update' AND details ? 'appAccess' ORDER BY id LIMIT 1`, [A.id])
  assert.equal(log.details.appAccess, false)

  // A deleted person arrives as a revoked entry.
  await sql('DELETE FROM users WHERE id = $1', [A.member])
  const gone = (await sync(A.id, since)).people.find(x => x.id === A.member)
  assert.deepEqual(gone, { id: A.member, team_id: '', version: gone.version, revoked: true })
})

test('delegation: usage reported for a person is theirs, through the agent', { skip }, async () => {
  const B = await org()
  const r = await call('agents', 'POST', { as: B.owner, body: { name: 'portal', teamId: B.eng, delegates: true } })
  const agent = r.body.agent.id
  const ingest = await import('../app/api/internal/usage/route.js')
  const rec = (extra) => ({
    id: randomUUID(), ts: new Date().toISOString(), key_id: `agent:${agent}`, team_id: B.sales,
    provider: 'openai', model: 'gpt-4o-mini', status: 200, reason: 'ok', stream: true,
    duration_ms: 900, upstream_ms: 300, tokens_in: 120, tokens_out: 80, ...extra,
  })
  const forAna = rec({ user_id: B.member })
  const [stranger] = await sql(`SELECT id FROM users WHERE org_id = $1 AND role = 'owner'`, [A.id])
  const foreign = rec({ user_id: stranger.id })
  const bad = rec({ user_id: 'not-a-uuid' })
  const res = await ingest.POST(new NextRequest('http://console.test/api/internal/usage', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${B.token}` },
    body: JSON.stringify({ instance_id: B.instance, records: [forAna, foreign, bad] }),
  }), { params: Promise.resolve({}) })
  assert.equal(res.status, 200)

  const row = async (r) => (await sql('SELECT user_id, agent_id, team_id FROM request_logs WHERE id = $1', [r.id]))[0]
  assert.deepEqual(await row(forAna), { user_id: B.member, agent_id: agent, team_id: B.sales })
  // A person of another organization, or a malformed id, is not attributed.
  assert.deepEqual(await row(foreign), { user_id: null, agent_id: agent, team_id: B.sales })
  assert.deepEqual(await row(bad), { user_id: null, agent_id: agent, team_id: B.sales })
})
