// Consumption by team, agent, person, model and provider (lib/consumption.js).
//
//   DATABASE_URL=postgres://... node --import ./test/register.mjs --test test/
//
// Skipped without DATABASE_URL.

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

const pg = (await import('pg')).default
const { consumption, parseQuery } = await import('../lib/consumption.js')

const url = process.env.DATABASE_URL
const skip = url ? false : 'DATABASE_URL not set'
let db
const orgs = []
const sql = async (text, params = []) => (await db.query(text, params)).rows

let A, B
const FROM = new Date('2026-10-01T00:00:00Z')
const TO = new Date('2026-10-31T23:59:59.999Z')

async function org() {
  const id = randomUUID()
  orgs.push(id)
  await sql('INSERT INTO organizations (id, name) VALUES ($1, $2)', [id, `k-${id.slice(0, 8)}`])
  const [eng] = await sql(`INSERT INTO teams (org_id, name) VALUES ($1, 'Ingeniería') RETURNING id`, [id])
  const [mkt] = await sql(`INSERT INTO teams (org_id, name) VALUES ($1, 'Marketing') RETURNING id`, [id])
  const [ana] = await sql(`INSERT INTO users (org_id, team_id, email, name) VALUES ($1, $2, $3, 'Ana') RETURNING id`,
    [id, eng.id, `ana-${id.slice(0, 8)}@example.com`])
  const [bot] = await sql(`INSERT INTO agents (org_id, team_id, name) VALUES ($1, $2, 'bot-hora') RETURNING id`, [id, eng.id])
  return { id, eng: eng.id, mkt: mkt.id, ana: ana.id, bot: bot.id }
}

// One request_logs row.
async function log(o, { day, team, user = null, agent = null, provider = 'anthropic', model = 'claude-haiku-4-5',
  status = 200, reason = null, tin = 100, tout = 50, cost = 0.001, ms = 400 }) {
  await sql(`
    INSERT INTO request_logs (id, created_at, org_id, team_id, user_id, agent_id, provider, model_id,
                              tokens_input, tokens_output, cost_usd, status_code, latency_ms, error_message, provider_ms)
    VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
  [new Date(`2026-10-${day}T12:00:00Z`), o.id, team, user, agent, provider, model, tin, tout, cost, status, ms, reason,
   reason === 'model_not_allowed' || provider === '' ? 0 : ms - 10]) // refusals never reach a provider
}

before(async () => {
  if (!url) return
  db = new pg.Pool({ connectionString: url, max: 2 })
  A = await org()
  B = await org()
  for (const day of ['03', '03', '04']) await log(A, { day, team: A.eng, agent: A.bot, ms: 300 })
  await log(A, { day: '04', team: A.eng, agent: A.bot, status: 403, reason: 'model_not_allowed', tin: 0, tout: 0, cost: 0, ms: 2 })
  await log(A, { day: '04', team: A.eng, agent: A.bot, status: 502, reason: 'upstream_unreachable', tin: 0, tout: 0, cost: 0, ms: 900 })
  await log(A, { day: '05', team: A.eng, user: A.ana, provider: 'openai', model: 'gpt-5.5', cost: 0.01, ms: 1200 })
  await log(A, { day: '05', team: A.mkt, provider: 'openai', model: 'gpt-5.5', cost: 0.02 })
  await log(A, { day: '30', team: A.mkt, cost: 0.5 }) // still October
  await log(A, { day: '06', team: A.mkt, provider: '', model: 'llama3', status: 400, reason: 'ambiguous_provider', cost: 0, ms: 1 })
  await log(B, { day: '05', team: B.eng, agent: B.bot, cost: 9 }) // another organization
})

after(async () => {
  if (!db) return
  await sql('DELETE FROM request_logs WHERE org_id = ANY($1::uuid[])', [orgs])
  await sql('DELETE FROM organizations WHERE id = ANY($1::uuid[])', [orgs])
  await db.end()
})

const ORG = () => ({ orgId: A.id, scope: 'org' })

test('consumption: by agent, only agent traffic, with errors, refusals and latency', { skip }, async () => {
  const r = await consumption(db, ORG(), { from: FROM, to: TO, by: 'agent', filter: null })
  assert.equal(r.rows.length, 1)
  const bot = r.rows[0]
  assert.deepEqual([bot.key, bot.label], [A.bot, 'bot-hora'])
  assert.equal(bot.requests, 5)
  assert.equal(bot.errors, 2)
  assert.equal(bot.blocked, 1, 'model_not_allowed is a refusal by policy; a 502 is not')
  assert.equal(bot.tokens_in, 300)
  assert.ok(Math.abs(bot.cost - 0.003) < 1e-9)
  assert.equal(bot.p50_ms, 300, 'the 2 ms refusal is not in the latency')
  assert.equal(bot.p95_ms, 810) // 300, 300, 300, 900: interpolated
  assert.deepEqual(r.totals.requests, 5, 'totals cover the same rows: people excluded')
  // Daily series per UTC day.
  assert.deepEqual(r.days.map(d => [d.day, d.requests]), [['2026-10-03', 2], ['2026-10-04', 3]])
})

test('consumption: by team, model and provider; another organization never counts', { skip }, async () => {
  const teams = await consumption(db, ORG(), { from: FROM, to: TO, by: 'team', filter: null })
  assert.deepEqual(teams.rows.map(r => [r.label, r.requests]), [['Marketing', 3], ['Ingeniería', 6]])
  assert.equal(teams.totals.requests, 9)
  const models = await consumption(db, ORG(), { from: FROM, to: TO, by: 'model', filter: null })
  assert.deepEqual(models.rows.map(r => r.key ?? 'null').sort(), ['anthropic/claude-haiku-4-5', 'null', 'openai/gpt-5.5'])
  const providers = await consumption(db, ORG(), { from: FROM, to: TO, by: 'provider', filter: null })
  assert.ok(!providers.rows.some(r => r.cost >= 9))
  // Refused before a provider was chosen: no provider, shown as such.
  const none = providers.rows.find(r => r.key == null)
  assert.deepEqual([none.label, none.requests], ['Sin asignar', 1])
})

test('consumption: drill down into one agent, by model', { skip }, async () => {
  const r = await consumption(db, ORG(), { from: FROM, to: TO, by: 'model', filter: { kind: 'agent', value: A.bot } })
  assert.deepEqual(r.filter, { kind: 'agent', value: A.bot, label: 'bot-hora' })
  assert.deepEqual(r.rows.map(x => [x.key, x.requests]), [['anthropic/claude-haiku-4-5', 5]])
  // Another organization's agent: nothing, and no name.
  const other = await consumption(db, ORG(), { from: FROM, to: TO, by: 'model', filter: { kind: 'agent', value: B.bot } })
  assert.equal(other.rows.length, 0)
  assert.equal(other.filter.label, null)
})

test('consumption: a team manager sees only their team, and no other team\'s names', { skip }, async () => {
  const mgr = { orgId: A.id, scope: 'team', teamId: A.mkt }
  const r = await consumption(db, mgr, { from: FROM, to: TO, by: 'team', filter: null })
  assert.deepEqual(r.rows.map(x => x.label), ['Marketing'])
  const peek = await consumption(db, mgr, { from: FROM, to: TO, by: 'model', filter: { kind: 'user', value: A.ana } })
  assert.equal(peek.rows.length, 0)
  assert.equal(peek.filter.label, null, 'Ana is in Ingeniería: her name is not shown')
})

test('parseQuery: one dimension, one filter, valid ids', () => {
  const q = s => parseQuery(new URLSearchParams(s))
  assert.deepEqual(q(''), { by: 'team', filter: null })
  assert.deepEqual(q('by=model&provider=openai'), { by: 'model', filter: { kind: 'provider', value: 'openai' } })
  for (const bad of ['by=color', 'agent=x', 'agent=' + randomUUID() + '&team=' + randomUUID()]) {
    assert.throws(() => q(bad), /./, bad)
  }
})

test('consumption: estimated emissions add up as ranges; requests without an estimate are counted apart', { skip }, async () => {
  const C = await org()
  const row = async (team, impact, tout = 50) => sql(`
    INSERT INTO request_logs (id, created_at, org_id, team_id, provider, model_id, tokens_input, tokens_output, cost_usd,
                              status_code, latency_ms, provider_ms,
                              impact_gwp_g_min, impact_gwp_g_max, impact_energy_wh_min, impact_energy_wh_max,
                              impact_water_ml_min, impact_water_ml_max, impact_method)
    VALUES (gen_random_uuid(), '2026-10-07T12:00:00Z', $1, $2, 'openai', 'gpt-4o-mini', 10, $3, 0, 200, 500, 490,
            $4, $5, $6, $7, $8, $9, $10)`,
  [C.id, team, tout, ...(impact ? [impact[0], impact[1], 1, 2, 3, 4, 'ecologits-0.11.3'] : [null, null, null, null, null, null, null])])
  await row(C.eng, [0.5, 1.5])
  await row(C.eng, [1, 2])
  await row(C.eng, null)          // a model without an estimate
  await row(C.eng, null, 0)       // no output: nothing to estimate, not "missing"
  await row(C.mkt, null)

  const r = await consumption(db, { orgId: C.id, scope: 'org' }, { from: FROM, to: TO, by: 'team', filter: null })
  assert.deepEqual(r.totals.impact.gwp_g, { min: 1.5, max: 3.5 })
  assert.deepEqual(r.totals.impact.energy_wh, { min: 2, max: 4 })
  assert.equal(r.totals.impact.estimated, 2)
  assert.equal(r.totals.impact.missing, 2)
  assert.equal(r.totals.impact.tokens_out, 100)

  const eng = r.rows.find(x => x.key === C.eng)
  const mkt = r.rows.find(x => x.key === C.mkt)
  assert.deepEqual([eng.impact.gwp_g, eng.impact.missing], [{ min: 1.5, max: 3.5 }, 1])
  assert.equal(mkt.impact.gwp_g, null, 'no estimate is no number, never zero')
  assert.equal(mkt.impact.missing, 1)
  const day = r.days.find(d => d.key === C.eng)
  assert.equal(day.co2, 2.5, 'the daily series carries the middle of the range')
})
