// Deleting an organization in two steps (ADR-0020, migration 047), against
// PostgreSQL.
//
//   DATABASE_URL=postgres://... node --import ./test/register.mjs --test test/
//
// Skipped without DATABASE_URL.

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID, randomBytes } from 'node:crypto'
import pg from 'pg'
import { markForDeletion, undoDeletion, purgeDue, GRACE_DAYS } from '../lib/org-deletion.js'

const url = process.env.DATABASE_URL
const skip = url ? false : 'DATABASE_URL not set'
const ACTOR = 'test'
let pool, client
const orgs = []

before(async () => {
  if (!url) return
  pool = new pg.Pool({ connectionString: url, max: 4 })
  client = await pool.connect()
})
after(async () => {
  if (!pool) return
  // Organizations that survived a test (not marked, or undone).
  await pool.query('DELETE FROM alerts WHERE org_id = ANY($1::uuid[])', [orgs])
  await pool.query('DELETE FROM organizations WHERE id = ANY($1::uuid[])', [orgs])
  client.release()
  await pool.end()
})

const sql = async (text, params = []) => (await pool.query(text, params)).rows
const count = async (table, orgId) => (await sql(`SELECT count(*)::int AS n FROM ${table} WHERE org_id = $1`, [orgId]))[0].n

// An organization with a bit of everything: people, a team and its policy,
// an agent, a gateway with metrics, a provider, requests, an alert and
// entries in its audit log.
async function org(status = 'active') {
  const id = randomUUID()
  orgs.push(id)
  const name = `Acme ${id.slice(0, 6)}`
  await sql('INSERT INTO organizations (id, name, status) VALUES ($1, $2, $3)', [id, name, status])
  const [pol] = await sql(`INSERT INTO policies (org_id, name) VALUES ($1, 'p') RETURNING id`, [id])
  const [team] = await sql(`INSERT INTO teams (org_id, name, policy_id) VALUES ($1, 't', $2) RETURNING id`, [id, pol.id])
  await sql(`INSERT INTO users (org_id, team_id, email, role) VALUES ($1, $2, $3, 'member')`, [id, team.id, `ana-${id}@example.com`])
  await sql(`INSERT INTO agents (org_id, team_id, name) VALUES ($1, $2, 'bot')`, [id, team.id])
  const gw = `dp_${randomBytes(8).toString('hex')}`
  await sql(`INSERT INTO data_plane_instances (id, org_id, name, sync_token_hash) VALUES ($1, $2, 'gw', $3)`, [gw, id, randomBytes(16).toString('hex')])
  await sql(`INSERT INTO stratum_metrics (instance_id, window_start, window_end, team_id, model) VALUES ($1, now(), now(), $2, 'm')`, [gw, team.id])
  await sql(`INSERT INTO provider_configs (id, org_id, provider, display_name, api_key_encrypted) VALUES ($1, $2, 'openai', 'OpenAI', 'x')`,
    [`pc_${randomBytes(8).toString('hex')}`, id])
  await sql(`INSERT INTO request_logs (org_id, team_id, provider, model_id, tokens_input, tokens_output, cost_usd)
             SELECT $1, $2, 'openai', 'gpt-4o', 100, 50, 0.01 FROM generate_series(1, 7)`, [id, team.id])
  await sql(`INSERT INTO alerts (org_id, team_id, alert_type, destination) VALUES ($1, $2, 'budget', 'ops@example.com')`, [id, team.id])
  await sql(`INSERT INTO audit_log (org_id, action, result) VALUES ($1, 'user.create', 'ok')`, [id])
  return { id, name }
}

const platform = (orgId) => sql('SELECT action, actor, org_name, details FROM platform_audit WHERE org_id = $1 ORDER BY id', [orgId])

test('deletion: the name confirms it, and a reason is kept', { skip }, async () => {
  const A = await org()
  await assert.rejects(markForDeletion(client, { orgId: A.id, confirmName: 'Acme', reason: 'cliente se fue', actor: ACTOR }), /does not match/)
  await assert.rejects(markForDeletion(client, { orgId: A.id, confirmName: A.name, reason: 'x', actor: ACTOR }), /reason is required/)
  await assert.rejects(markForDeletion(client, { orgId: randomUUID(), confirmName: A.name, reason: 'cliente se fue', actor: ACTOR }), /No organization/)
  assert.equal((await sql('SELECT status FROM organizations WHERE id = $1', [A.id]))[0].status, 'active')

  const r = await markForDeletion(client, { orgId: A.id, confirmName: ` ${A.name} `, reason: 'cliente se fue', actor: ACTOR })
  const days = (r.deleteAfter - Date.now()) / 86400e3
  assert.ok(days > GRACE_DAYS - 0.01 && days <= GRACE_DAYS, `${days} days`)
  const [o] = await sql('SELECT status, status_before_delete FROM organizations WHERE id = $1', [A.id])
  assert.deepEqual(o, { status: 'suspended', status_before_delete: 'active' })
  await assert.rejects(markForDeletion(client, { orgId: A.id, confirmName: A.name, reason: 'otra vez', actor: ACTOR }), /already marked/)

  // In both audit logs: the organization's, which its people read until it
  // goes, and the platform's, which outlives it.
  const [own] = await sql(`SELECT actor_label, details FROM audit_log WHERE org_id = $1 AND action = 'org.delete'`, [A.id])
  assert.equal(own.actor_label, ACTOR)
  assert.equal(own.details.reason, 'cliente se fue')
  assert.deepEqual((await platform(A.id)).map(e => [e.action, e.org_name]), [['org.delete', A.name]])

  // Not due yet: the maintenance leaves it whole.
  assert.ok(!(await purgeDue(pool)).some(d => d.orgId === A.id))
  assert.equal(await count('request_logs', A.id), 7)
})

test('deletion: undone, it goes back to the state it had', { skip }, async () => {
  const A = await org('active')
  const S = await org('suspended')
  for (const o of [A, S]) await markForDeletion(client, { orgId: o.id, confirmName: o.name, reason: 'por error', actor: ACTOR })
  assert.equal((await undoDeletion(client, { orgId: A.id, reason: 'se arrepintió', actor: ACTOR })).status, 'active')
  assert.equal((await undoDeletion(client, { orgId: S.id, reason: 'se arrepintió', actor: ACTOR })).status, 'suspended')
  const [o] = await sql('SELECT status, delete_after, status_before_delete FROM organizations WHERE id = $1', [A.id])
  assert.deepEqual(o, { status: 'active', delete_after: null, status_before_delete: null })
  await assert.rejects(undoDeletion(client, { orgId: A.id, reason: 'otra vez', actor: ACTOR }), /not marked/)
  assert.deepEqual((await platform(A.id)).map(e => e.action), ['org.delete', 'org.undelete'])
})

test('deletion: once due, everything goes but the platform\'s record', { skip }, async () => {
  const A = await org()
  const B = await org() // stays
  await markForDeletion(client, { orgId: A.id, confirmName: A.name, reason: 'cliente se fue', actor: ACTOR })
  await sql(`UPDATE organizations SET delete_after = now() - interval '1 minute' WHERE id = $1`, [A.id])

  const done = (await purgeDue(pool, { batch: 3 })).filter(d => d.orgId === A.id)
  assert.deepEqual(done, [{ orgId: A.id, name: A.name, counts: { people: 1, agents: 1, teams: 1, gateways: 1 } }])

  assert.equal((await sql('SELECT count(*)::int AS n FROM organizations WHERE id = $1', [A.id]))[0].n, 0)
  for (const t of ['users', 'teams', 'policies', 'agents', 'data_plane_instances', 'provider_configs',
    'request_logs', 'alerts', 'audit_log', 'team_usage_monthly', 'stratum_sync_tombstones']) {
    assert.equal(await count(t, A.id), 0, t)
  }
  // The other organization keeps everything.
  for (const [t, n] of [['users', 1], ['request_logs', 7], ['alerts', 1], ['audit_log', 1]]) {
    assert.equal(await count(t, B.id), n, `B ${t}`)
  }

  const record = (await platform(A.id)).at(-1)
  assert.equal(record.action, 'org.purge')
  assert.equal(record.actor, 'maintenance')
  assert.equal(record.org_name, A.name)
  assert.deepEqual(record.details.usage.map(u => [u.tokens, u.requests, u.cost_usd]), [[1050, 7, 0.07]])

  await assert.rejects(undoDeletion(client, { orgId: A.id, reason: 'tarde', actor: ACTOR }), /already deleted/)
})

test('deletion: the audit logs stay append-only otherwise', { skip }, async () => {
  const B = await org()
  await assert.rejects(sql('DELETE FROM audit_log WHERE org_id = $1', [B.id]), /audit_log is append-only/)
  // Marked but not due: still append-only.
  await markForDeletion(client, { orgId: B.id, confirmName: B.name, reason: 'cliente se fue', actor: ACTOR })
  await assert.rejects(sql('DELETE FROM audit_log WHERE org_id = $1', [B.id]), /append-only/)
  await assert.rejects(sql('DELETE FROM platform_audit WHERE org_id = $1', [B.id]), /platform_audit is append-only/)
  await assert.rejects(sql(`UPDATE platform_audit SET actor = 'x' WHERE org_id = $1`, [B.id]), /append-only/)
  await undoDeletion(client, { orgId: B.id, reason: 'era una prueba', actor: ACTOR })
})
