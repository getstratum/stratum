// Usage reports for applications (lib/usage-report.js).
//
//   DATABASE_URL=postgres://... node --import ./test/register.mjs --test test/
//
// Skipped without DATABASE_URL.

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

const pg = (await import('pg')).default
const { usageReport, reportScopes, parseMonth, MIN_PEOPLE } = await import('../lib/usage-report.js')

const url = process.env.DATABASE_URL
const skip = url ? false : 'DATABASE_URL not set'
let db
const orgs = []
const sql = async (text, params = []) => (await db.query(text, params)).rows
const NOW = new Date('2026-10-20T12:00:00Z')
let O, client

async function person(org, team, name, role = 'member', extra = '') {
  const [u] = await sql(`INSERT INTO users (org_id, team_id, email, name, role${extra ? ', app_access' : ''})
                         VALUES ($1, $2, $3, $4, $5${extra ? ', false' : ''}) RETURNING id`,
  [org, team, `${name.toLowerCase()}-${org.slice(0, 8)}@example.com`, name, role])
  return u.id
}

async function log(o, { day, team, user = null, agent = null, cost = 0.01, labels = [], model = 'gpt-4o-mini', status = 200, reason = null }) {
  await sql(`
    INSERT INTO request_logs (id, created_at, org_id, team_id, user_id, agent_id, provider, model_id,
                              tokens_input, tokens_output, cost_usd, status_code, latency_ms, provider_ms, error_message, labels)
    VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, 'openai', $6, 100, 50, $7, $8, 400, 390, $9, $10)`,
  [new Date(`2026-${day}T12:00:00Z`), o.id, team, user, agent, model, cost, status, reason, labels])
}

before(async () => {
  if (!url) return
  db = new pg.Pool({ connectionString: url, max: 2 })
  const id = randomUUID()
  orgs.push(id)
  await sql('INSERT INTO organizations (id, name) VALUES ($1, $2)', [id, `r-${id.slice(0, 8)}`])
  const [eng] = await sql(`INSERT INTO teams (org_id, name, monthly_budget_usd) VALUES ($1, 'Ingeniería', 50) RETURNING id`, [id])
  const [mkt] = await sql(`INSERT INTO teams (org_id, name) VALUES ($1, 'Marketing') RETURNING id`, [id])
  O = { id, eng: eng.id, mkt: mkt.id }
  O.lead = await person(id, eng.id, 'Lía', 'team_manager')
  O.ana = await person(id, eng.id, 'Ana')
  O.bob = await person(id, eng.id, 'Bob')
  O.leo = await person(id, mkt.id, 'Leo', 'team_manager')
  O.mia = await person(id, mkt.id, 'Mía')
  O.off = await person(id, eng.id, 'Sin acceso', 'member', 'no app access')
  const [bot] = await sql(`INSERT INTO agents (org_id, team_id, name) VALUES ($1, $2, 'bot') RETURNING id`, [id, eng.id])
  const [portal] = await sql(`INSERT INTO agents (org_id, team_id, name, delegates) VALUES ($1, $2, 'portal', true) RETURNING id`, [id, eng.id])
  client = { id: 'app_test', org_id: id, usage_reports: true }

  await log(O, { day: '10-02', team: O.eng, user: O.ana, agent: portal.id, labels: ['portal', 'topic_code'] })
  await log(O, { day: '10-02', team: O.eng, user: O.ana, agent: portal.id, labels: ['portal'], model: 'gpt-5.4', cost: 0.1 })
  await log(O, { day: '10-03', team: O.eng, user: O.bob, agent: portal.id, labels: ['portal', 'portal_compact'] })
  await log(O, { day: '10-03', team: O.eng, user: O.lead, labels: [] })                       // Lía's own key
  await log(O, { day: '10-04', team: O.eng, agent: bot.id, cost: 0.5 })                       // the bot's own work
  await log(O, { day: '10-05', team: O.eng, user: O.ana, status: 403, reason: 'sensitive_data_detected', cost: 0 })
  await log(O, { day: '09-28', team: O.eng, user: O.ana, cost: 9 })                           // September
  await log(O, { day: '10-06', team: O.mkt, user: O.mia, cost: 1 })
  await log(O, { day: '10-06', team: O.mkt, user: O.leo, cost: 1 })
})

after(async () => {
  if (!db) return
  await sql('DELETE FROM request_logs WHERE org_id = ANY($1::uuid[])', [orgs])
  await sql('DELETE FROM organizations WHERE id = ANY($1::uuid[])', [orgs])
  await db.end()
})

const report = (personId, kind, month = '2026-10') => usageReport(db, client, { personId, kind, month, now: NOW })
const refused = async (p, code) => {
  try { await p } catch (err) { assert.equal(err.code, code); return err }
  assert.fail(`expected ${code}`)
}

test('parseMonth: a month in UTC, not in the future, at most two years back', () => {
  const p = parseMonth('2026-10', NOW)
  assert.equal(p.from.toISOString(), '2026-10-01T00:00:00.000Z')
  assert.equal(p.to.toISOString(), '2026-11-01T00:00:00.000Z')
  for (const bad of ['2026-11', '2024-09', '2026-1', 'octubre', undefined]) assert.throws(() => parseMonth(bad, NOW), /./, bad)
})

test('scopes: everyone has their own; a team manager also their team; no access, no report', { skip }, async () => {
  assert.deepEqual((await reportScopes(db, client, O.ana)).team, null)
  assert.deepEqual((await reportScopes(db, client, O.lead)).team, { id: O.eng, name: 'Ingeniería' })
  assert.equal(await reportScopes(db, client, O.off), null)
  assert.equal(await reportScopes(db, { ...client, org_id: randomUUID() }, O.ana), null, 'another organization')
})

test('self: only the person\'s own usage in the month, by model, day and label', { skip }, async () => {
  const r = await report(O.ana, 'self')
  assert.equal(r.subject.name, 'Ana')
  assert.equal(r.totals.requests, 3)
  assert.equal(r.totals.blocked, 1, 'the refused one is counted as such')
  assert.ok(Math.abs(r.totals.cost - 0.11) < 1e-9, 'September is not in October')
  assert.deepEqual(r.by_model.map(m => m.model), ['openai/gpt-5.4', 'openai/gpt-4o-mini'])
  assert.deepEqual(r.by_day.map(d => [d.day, d.requests]), [['2026-10-02', 2], ['2026-10-05', 1]])
  assert.deepEqual(r.by_label.map(l => [l.label, l.requests]), [['portal', 2], ['topic_code', 1]])
  assert.equal(r.people, undefined)
})

test('team: added up for its manager, with no person apart', { skip }, async () => {
  const r = await report(O.lead, 'team')
  assert.equal(r.subject.name, 'Ingeniería')
  assert.equal(r.people, 3)
  assert.equal(r.totals.requests, 6)
  assert.equal(r.split.people.requests, 5)
  assert.equal(r.split.agents.requests, 1)
  assert.deepEqual(r.limits, { budget_usd: 50, token_quota: null })
  const text = JSON.stringify(r)
  for (const id of [O.ana, O.bob, O.lead]) assert.ok(!text.includes(id), 'no person\'s id')
  for (const name of ['Ana', 'Bob', 'Lía']) assert.ok(!text.includes(name), 'no person\'s name')
})

test('team: only for a team manager; not while fewer than the minimum used it', { skip }, async () => {
  await refused(report(O.ana, 'team'), 'not_team_manager')
  const err = await refused(report(O.leo, 'team'), 'too_few_people')
  assert.deepEqual(err.extra, { people: 2, min: MIN_PEOPLE })
  await refused(report(O.off, 'self'), 'unknown_user')
})
