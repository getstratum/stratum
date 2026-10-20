// Integration tests for the sync endpoint's body (lib/sync.js) against a
// real PostgreSQL with every migration applied.
//
//   DATABASE_URL=postgres://... node --test test/
//
// Skipped without DATABASE_URL. CI runs them against a PostgreSQL 16 service.
// Each test works in its own organisation, so they do not see each other.
//
// With SYNC_EXAMPLES_DIR set, the responses are also written there as JSON,
// so CI can validate them against api/sync/v2/sync-response.schema.json.

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import pg from 'pg'
import { buildSyncResponse } from '../lib/sync.js'

const url = process.env.DATABASE_URL
const skip = url ? false : 'DATABASE_URL not set'
let pool

const orgs = []
before(() => { if (url) pool = new pg.Pool({ connectionString: url, max: 4 }) })
after(async () => {
  if (!pool) return
  await pool.query('DELETE FROM organizations WHERE id = ANY($1::uuid[])', [orgs])
  await pool.query('DELETE FROM stratum_sync_tombstones WHERE org_id = ANY($1::uuid[])', [orgs])
  await pool.end()
})

async function sql(text, params = []) {
  return (await pool.query(text, params)).rows
}

let written = 0
async function sync(orgId, since) {
  const client = await pool.connect()
  try {
    const body = await buildSyncResponse(client, {
      orgId, sinceVersion: since, syncIntervalS: 30, decrypt: v => `plain:${v}`, warn: () => {},
    })
    const json = JSON.parse(JSON.stringify(body)) // as the route serialises it
    if (process.env.SYNC_EXAMPLES_DIR) {
      writeFileSync(join(process.env.SYNC_EXAMPLES_DIR, `response-${++written}.json`), JSON.stringify(json, null, 2))
    }
    return json
  } finally {
    client.release()
  }
}

// An organisation with two policies, a team on the first one, a second team
// without users, two users with keys and one provider config.
async function fixture() {
  const org = randomUUID()
  orgs.push(org)
  await sql(`INSERT INTO organizations (id, name) VALUES ($1, 'test')`, [org])
  const [p1] = await sql(`INSERT INTO policies (org_id, name, allowed_models) VALUES ($1, 'p1', '{gpt-4o}') RETURNING id`, [org])
  const [p2] = await sql(`INSERT INTO policies (org_id, name, allow_all_models) VALUES ($1, 'p2', true) RETURNING id`, [org])
  const [team] = await sql(`INSERT INTO teams (org_id, name, policy_id) VALUES ($1, 'eng', $2) RETURNING id`, [org, p1.id])
  const [empty] = await sql(`INSERT INTO teams (org_id, name, policy_id) VALUES ($1, 'temp', $2) RETURNING id`, [org, p1.id])
  const user = async n => (await sql(
    `INSERT INTO users (org_id, team_id, email, name, api_key_hash) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [org, team.id, `${n}-${org}@example.com`, n, randomBytes(32).toString('hex')]))[0].id
  const u1 = await user('ana')
  const u2 = await user('bruno')
  const [pc] = await sql(
    `INSERT INTO provider_configs (id, org_id, provider, display_name, api_key_encrypted, enabled)
     VALUES ($2, $1, 'openai', 'OpenAI', 'iv:ct', true) RETURNING id`, [org, `pc_${randomUUID()}`])
  return { org, p1: p1.id, p2: p2.id, team: team.id, empty: empty.id, u1, u2, pc: pc.id }
}

const key = (body, id) => body.api_keys.find(k => k.id === id)
const policyOf = (body, team) => body.policies.find(p => p.team_id === team)

test('full sync: active keys, one policy per team, provider keys decrypted', { skip }, async () => {
  const f = await fixture()
  const body = await sync(f.org, 0)
  assert.ok(body.current_version > 0)
  assert.equal(key(body, f.u1).revoked, false)
  assert.equal(policyOf(body, f.team).id, f.p1)
  assert.equal(body.provider_configs[0].api_key, 'plain:iv:ct')
  const max = Math.max(...body.api_keys.map(k => k.version), ...body.policies.map(p => p.version),
    ...body.provider_configs.map(p => p.version))
  assert.ok(body.current_version >= max, 'current_version covers every row returned')
})

test('removing a key reaches gateways in the next delta as a revocation', { skip }, async () => {
  const f = await fixture()
  const v0 = (await sync(f.org, 0)).current_version
  await sql(`UPDATE users SET api_key_hash = NULL, api_key_prefix = NULL WHERE id = $1`, [f.u1])
  const d = await sync(f.org, v0)
  assert.ok(d.current_version > v0, 'the version moves')
  const k = key(d, f.u1)
  assert.ok(k, 'the removed key is in the delta')
  assert.equal(k.revoked, true)
  assert.equal(k.key_hash, '')
  assert.ok(k.version > v0)
  assert.equal(key(d, f.u2), undefined, 'unchanged keys are not resent')
  // A full sync keeps reporting it as revoked, so the gateway's guard sees an
  // explicit revocation instead of a key that vanished.
  assert.equal(key(await sync(f.org, 0), f.u1).revoked, true)
})

test('deactivating a user revokes the key; reactivating restores it', { skip }, async () => {
  const f = await fixture()
  const v0 = (await sync(f.org, 0)).current_version
  await sql(`UPDATE users SET is_active = false WHERE id = $1`, [f.u2])
  const d1 = await sync(f.org, v0)
  assert.equal(key(d1, f.u2).revoked, true)
  assert.notEqual(key(d1, f.u2).key_hash, '')
  await sql(`UPDATE users SET is_active = true WHERE id = $1`, [f.u2])
  const d2 = await sync(f.org, d1.current_version)
  assert.equal(key(d2, f.u2).revoked, false)
  assert.ok(key(d2, f.u2).version > key(d1, f.u2).version)
})

test('a user without a team cannot use the key', { skip }, async () => {
  const f = await fixture()
  const v0 = (await sync(f.org, 0)).current_version
  await sql(`UPDATE users SET team_id = NULL WHERE id = $1`, [f.u2])
  assert.equal(key(await sync(f.org, v0), f.u2).revoked, true)
})

test('moving a team to an older policy replaces the one gateways have', { skip }, async () => {
  const f = await fixture()
  // p2 was created before p1 was last touched: its version is lower.
  await sql(`UPDATE policies SET name = 'p1 edited' WHERE id = $1`, [f.p1])
  const full = await sync(f.org, 0)
  const before = policyOf(full, f.team)
  await sql(`UPDATE teams SET policy_id = $2 WHERE id = $1`, [f.team, f.p2])
  const d = await sync(f.org, full.current_version)
  const after = policyOf(d, f.team)
  assert.equal(after.id, f.p2)
  assert.equal(after.allow_all_models, true)
  assert.ok(after.version > before.version, 'higher than what the gateway holds for the team')
})

test('a team left without a policy is disabled', { skip }, async () => {
  const f = await fixture()
  const v0 = (await sync(f.org, 0)).current_version
  await sql(`UPDATE teams SET policy_id = NULL WHERE id = $1`, [f.team])
  const p = policyOf(await sync(f.org, v0), f.team)
  assert.equal(p.revoked, true)
  assert.equal(p.id, '')
})

test('deletions travel as revocations and the version never goes backwards', { skip }, async () => {
  const f = await fixture()
  const v0 = (await sync(f.org, 0)).current_version

  await sql(`DELETE FROM provider_configs WHERE id = $1`, [f.pc])
  await sql(`DELETE FROM teams WHERE id = $1`, [f.empty])
  await sql(`DELETE FROM users WHERE id = $1`, [f.u1])
  const d = await sync(f.org, v0)
  assert.deepEqual(
    d.provider_configs.map(p => [p.id, p.provider, p.revoked, p.enabled]),
    [[f.pc, 'openai', true, false]])
  assert.equal(policyOf(d, f.empty).revoked, true)
  assert.equal(key(d, f.u1).revoked, true)

  // Deleting the most recently changed policy must not lower the version:
  // gateways would read that as a database restored from a backup.
  const [fresh] = await sql(`INSERT INTO policies (org_id, name) VALUES ($1, 'tmp') RETURNING id`, [f.org])
  const high = (await sync(f.org, 0)).current_version
  await sql(`DELETE FROM policies WHERE id = $1`, [fresh.id])
  assert.ok((await sync(f.org, 0)).current_version > high)
})

test('a key removed and then its user deleted still arrives as revoked', { skip }, async () => {
  const f = await fixture()
  const v0 = (await sync(f.org, 0)).current_version
  await sql(`UPDATE users SET api_key_hash = NULL WHERE id = $1`, [f.u1])
  await sql(`UPDATE policies SET name = 'edited' WHERE id = $1`, [f.p2])
  await sql(`DELETE FROM users WHERE id = $1`, [f.u1])
  const d = await sync(f.org, v0)
  assert.equal(key(d, f.u1)?.revoked, true)

  // Deleting a user that never had a key does not lower the version either.
  const [u] = await sql(`INSERT INTO users (org_id, email) VALUES ($1, $2) RETURNING id`, [f.org, `x-${f.org}@example.com`])
  const high = (await sync(f.org, 0)).current_version
  await sql(`DELETE FROM users WHERE id = $1`, [u.id])
  assert.ok((await sync(f.org, 0)).current_version > high)
})

test('changes in another organisation do not move this one', { skip }, async () => {
  const a = await fixture()
  const b = await fixture()
  const v = (await sync(a.org, 0)).current_version
  await sql(`UPDATE users SET is_active = false WHERE id = $1`, [b.u1])
  await sql(`UPDATE policies SET name = 'x' WHERE id = $1`, [b.p1])
  const d = await sync(a.org, v)
  assert.equal(d.current_version, v)
  assert.equal(d.api_keys.length + d.policies.length + d.provider_configs.length, 0)
})

test('agent keys travel like user keys, under agent: ids', { skip }, async () => {
  const f = await fixture()
  const hash = randomBytes(32).toString('hex')
  const [agent] = await sql(
    `INSERT INTO agents (org_id, team_id, name, api_key_hash, api_key_prefix) VALUES ($1, $2, 'bot', $3, 'aig_agt_x') RETURNING id`,
    [f.org, f.team, hash])
  const id = `agent:${agent.id}`

  const full = await sync(f.org, 0)
  assert.equal(key(full, id).key_hash, hash)
  assert.equal(key(full, id).team_id, f.team)
  assert.equal(key(full, id).revoked, false)
  assert.ok(full.current_version >= key(full, id).version, 'the watermark covers agent keys')

  // Rotation reaches gateways in a delta.
  const rotated = randomBytes(32).toString('hex')
  await sql('UPDATE agents SET api_key_hash = $2 WHERE id = $1', [agent.id, rotated])
  const d1 = await sync(f.org, full.current_version)
  assert.equal(key(d1, id).key_hash, rotated)

  // Deactivated: revoked, hash kept.
  await sql('UPDATE agents SET is_active = false WHERE id = $1', [agent.id])
  const d2 = await sync(f.org, d1.current_version)
  assert.equal(key(d2, id).revoked, true)
  await sql('UPDATE agents SET is_active = true WHERE id = $1', [agent.id])
  assert.equal(key(await sync(f.org, d2.current_version), id).revoked, false)

  // Key removed: revoked with an empty hash, in deltas and full syncs.
  const v3 = (await sync(f.org, 0)).current_version
  await sql('UPDATE agents SET api_key_hash = NULL, api_key_prefix = NULL WHERE id = $1', [agent.id])
  const d3 = await sync(f.org, v3)
  assert.deepEqual([key(d3, id).revoked, key(d3, id).key_hash], [true, ''])
  assert.equal(key(await sync(f.org, 0), id).revoked, true)

  // Deleted: a tombstone, and the version does not go backwards.
  await sql('UPDATE agents SET api_key_hash = $2 WHERE id = $1', [agent.id, hash])
  const v4 = (await sync(f.org, 0)).current_version
  await sql('DELETE FROM agents WHERE id = $1', [agent.id])
  const d4 = await sync(f.org, v4)
  assert.equal(key(d4, id).revoked, true)
  assert.ok(d4.current_version > v4)
})

test('an agent\'s fixed model travels with its key, and changing it is a delta', { skip }, async () => {
  const f = await fixture()
  const [agent] = await sql(
    `INSERT INTO agents (org_id, team_id, name, api_key_hash, default_provider, default_model)
     VALUES ($1, $2, 'bot', $3, 'openai', 'gpt-4o-mini') RETURNING id`,
    [f.org, f.team, randomBytes(32).toString('hex')])
  const id = `agent:${agent.id}`
  const full = await sync(f.org, 0)
  assert.deepEqual([key(full, id).default_provider, key(full, id).default_model], ['openai', 'gpt-4o-mini'])
  assert.ok(full.api_keys.filter(k => !k.id.startsWith('agent:')).every(k => k.default_model == null), 'people have none')

  await sql(`UPDATE agents SET default_provider = 'anthropic', default_model = 'claude-haiku-4-5' WHERE id = $1`, [agent.id])
  const d1 = await sync(f.org, full.current_version)
  assert.deepEqual([key(d1, id).default_provider, key(d1, id).default_model], ['anthropic', 'claude-haiku-4-5'])

  await sql(`UPDATE agents SET default_provider = NULL, default_model = '' WHERE id = $1`, [agent.id])
  const d2 = await sync(f.org, d1.current_version)
  assert.deepEqual([key(d2, id).default_provider, key(d2, id).default_model], [null, null])
})

test('an agent without a team or another organization\'s agent never works here', { skip }, async () => {
  const f = await fixture()
  const g = await fixture()
  const [noTeam] = await sql(
    `INSERT INTO agents (org_id, name, api_key_hash) VALUES ($1, 'loose', $2) RETURNING id`,
    [f.org, randomBytes(32).toString('hex')])
  const [other] = await sql(
    `INSERT INTO agents (org_id, team_id, name, api_key_hash) VALUES ($1, $2, 'other', $3) RETURNING id`,
    [g.org, g.team, randomBytes(32).toString('hex')])
  const body = await sync(f.org, 0)
  assert.equal(key(body, `agent:${noTeam.id}`).revoked, true)
  assert.equal(key(body, `agent:${other.id}`), undefined)
})

test('a policy that names a model allows every ID of it (migration 023)', { skip }, async () => {
  const f = await fixture()
  await sql(`UPDATE policies SET allowed_models = '{claude-haiku-4-5-20251001,openai/gpt-5.5,my-own-model}' WHERE id = $1`, [f.p1])
  const allowed = policyOf(await sync(f.org, 0), f.team).allowed_models
  for (const id of ['claude-haiku-4-5-20251001', 'claude-haiku-4-5', 'openai/gpt-5.5', 'openai/gpt-5.5-2026-04-23', 'my-own-model']) {
    assert.ok(allowed.includes(id), `${id} in ${allowed}`)
  }
  // Named with its provider, it is allowed only with its provider.
  assert.ok(!allowed.includes('gpt-5.5-2026-04-23'))
  assert.ok(!allowed.includes('claude-sonnet-4-6'))
})

test('a change to a model\'s IDs is a new version of the policies that name it; a price change is not', { skip }, async () => {
  const f = await fixture()
  await sql(`UPDATE policies SET allowed_models = '{claude-haiku-4-5}', allow_all_models = false WHERE id = $1`, [f.p2])
  const versions = async c => Object.fromEntries((await c.query(
    'SELECT id::text, version FROM policies WHERE id = ANY($1::uuid[])', [[f.p1, f.p2]])).rows.map(r => [r.id, Number(r.version)]))
  const client = await pool.connect()
  try {
    await client.query('BEGIN') // rolled back: other tests never see it
    const v0 = await versions(client)
    await client.query(`UPDATE ai_models SET cost_per_1k_input_tokens = 0.0011 WHERE model_id = 'claude-haiku-4-5-20251001'`)
    assert.deepEqual(await versions(client), v0, 'a price allows nothing new')
    await client.query(`UPDATE ai_models SET aliases = '{claude-haiku-4-5,claude-haiku-latest}' WHERE model_id = 'claude-haiku-4-5-20251001'`)
    const v1 = await versions(client)
    assert.ok(v1[f.p2] > v0[f.p2], 'p2 names Haiku: new version')
    assert.equal(v1[f.p1], v0[f.p1], 'p1 lists only gpt-4o: unchanged')
    await client.query(`INSERT INTO ai_models (provider, model_id, display_name) VALUES ('openai', 'sync-test-model', 'x')`)
    await client.query(`DELETE FROM ai_models WHERE model_id = 'sync-test-model'`)
    assert.deepEqual(await versions(client), v1, 'a model no policy names moves nothing')
  } finally {
    await client.query('ROLLBACK')
    client.release()
  }
})

test('month_usage: each team\'s tokens and cost this month, with every sync', { skip }, async () => {
  const f = await fixture()
  const log = (team, tokensIn, tokensOut, cost, at = 'now()') => sql(
    `INSERT INTO request_logs (id, created_at, org_id, team_id, tokens_input, tokens_output, cost_usd, provider, model_id, status_code)
     VALUES ($1, ${at}, $2, $3, $4, $5, $6, 'openai', 'gpt-4o', 200)`, [randomUUID(), f.org, team, tokensIn, tokensOut, cost])

  let body = await sync(f.org, 0)
  const month = new Date().toISOString().slice(0, 7)
  assert.deepEqual(body.month_usage, { month, teams: [] })

  await log(f.team, 1000, 250, 1.5)
  await log(f.team, 10, 5, 0.25)
  await log(f.empty, 7, 3, 0)
  // Last month does not count; a request without a team is not a team's.
  await log(f.team, 99999, 0, 99, "date_trunc('month', now()) - interval '1 day'")
  await log(null, 5, 5, 1)

  const full = await sync(f.org, 0)
  const delta = await sync(f.org, full.current_version) // nothing changed: still sent
  for (const b of [full, delta]) {
    assert.equal(b.month_usage.month, month)
    const byTeam = Object.fromEntries(b.month_usage.teams.map(t => [t.team_id, t]))
    assert.deepEqual(byTeam[f.team], { team_id: f.team, tokens: 1265, cost_usd: 1.75 })
    assert.deepEqual(byTeam[f.empty], { team_id: f.empty, tokens: 10, cost_usd: 0 })
    assert.equal(b.month_usage.teams.length, 2)
  }
  assert.equal(delta.policies.length, 0)

  // Usage is per organization.
  const other = await fixture()
  assert.deepEqual((await sync(other.org, 0)).month_usage.teams, [])
})

test('budgets: sent only when the policy cuts at them; the team\'s own budget wins', { skip }, async () => {
  const f = await fixture()
  await sql('UPDATE policies SET monthly_budget_usd = 100 WHERE id = $1', [f.p1])
  let body = await sync(f.org, 0)
  assert.equal(policyOf(body, f.team).monthly_budget_usd, null, 'a reference budget is not sent')

  await sql('UPDATE policies SET budget_enforced = true WHERE id = $1', [f.p1])
  body = await sync(f.org, 0)
  assert.equal(policyOf(body, f.team).monthly_budget_usd, 100)

  // The team's own budget replaces the policy's, and changing it reaches
  // gateways in a delta.
  const v = body.current_version
  await sql('UPDATE teams SET monthly_budget_usd = 40 WHERE id = $1', [f.team])
  const delta = await sync(f.org, v)
  assert.equal(delta.policies.length, 1)
  assert.equal(policyOf(delta, f.team).monthly_budget_usd, 40)
  assert.equal(policyOf(body, f.empty).monthly_budget_usd, 100)
})
