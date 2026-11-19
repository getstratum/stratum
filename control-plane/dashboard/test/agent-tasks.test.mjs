// An agent's results (the gateway's ADR-0019, lib/agent-tasks.js): tasks
// that ended, by their last outcome; their cost and time; open ones.
//
//   DATABASE_URL=postgres://... node --import ./test/register.mjs --test test/
//
// Skipped without DATABASE_URL.

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

const pg = (await import('pg')).default
const { closeDb } = await import('../lib/db.js')
const { summaries, detail } = await import('../lib/agent-tasks.js')

const url = process.env.DATABASE_URL
const skip = url ? false : 'DATABASE_URL not set'
let db, org, team, agent, other
const sql = async (text, params = []) => (await db.query(text, params)).rows

const ago = (minutes) => `now() - interval '${minutes} minutes'`
const request = (a, task, at, cost) => sql(
  `INSERT INTO request_logs (id, created_at, org_id, team_id, agent_id, provider, model_id, status_code, cost_usd, task)
   VALUES ($1, ${at}, $2, $3, $4, 'openai', 'gpt-4o', 200, $5, $6)`, [randomUUID(), org, team, a, cost, task])
const end = (a, task, at, outcome, reason = null, version = null) => sql(
  `INSERT INTO task_outcomes (id, created_at, org_id, team_id, agent_id, task, outcome, reason, agent_version)
   VALUES ($1, ${at}, $2, $3, $4, $5, $6, $7, $8)`, [randomUUID(), org, team, a, task, outcome, reason, version])

before(async () => {
  if (!url) return
  db = new pg.Pool({ connectionString: url, max: 2 })
  org = randomUUID()
  await sql('INSERT INTO organizations (id, name) VALUES ($1, $2)', [org, `t-${org.slice(0, 8)}`])
  team = (await sql(`INSERT INTO teams (org_id, name) VALUES ($1, 'Soporte') RETURNING id`, [org]))[0].id
  agent = (await sql(`INSERT INTO agents (org_id, team_id, name) VALUES ($1, $2, 'triage') RETURNING id`, [org, team]))[0].id
  other = (await sql(`INSERT INTO agents (org_id, team_id, name) VALUES ($1, $2, 'quiet') RETURNING id`, [org, team]))[0].id

  // t1: two requests, resolved after 10 minutes.
  await request(agent, 't1', ago(30), 0.01)
  await request(agent, 't1', ago(25), 0.03)
  await end(agent, 't1', ago(20), 'resolved')
  // t2: escalated, then reopened and resolved: the last one counts.
  await request(agent, 't2', ago(60), 0.02)
  await end(agent, 't2', ago(50), 'escalated', 'no_solution')
  await end(agent, 't2', ago(40), 'resolved')
  // t3: one unpriced request, escalated.
  await request(agent, 't3', ago(15), null)
  await end(agent, 't3', ago(5), 'escalated', 'customer_asked_for_a_person')
  // t4: failed, without requests.
  await end(agent, 't4', ago(3), 'failed', 'crm_down')
  // t5: requests, no outcome: open. t6: ended 40 days ago, out of 30.
  await request(agent, 't5', ago(2), 0.05)
  await end(agent, 't6', `now() - interval '40 days'`, 'resolved')
})

after(async () => {
  if (!db) return
  await sql('DELETE FROM request_logs WHERE org_id = $1', [org])
  await sql('DELETE FROM organizations WHERE id = $1', [org])
  await db.end()
  await closeDb()
})

test('summaries: tasks by their last outcome, their cost and time; open tasks; nothing for an agent without tasks', { skip }, async () => {
  const s = await summaries(db, org, [agent, other], 30)
  const a = s[agent]
  assert.deepEqual({ closed: a.closed, resolved: a.resolved, escalated: a.escalated, failed: a.failed, open: a.open },
    { closed: 4, resolved: 2, escalated: 1, failed: 1, open: 1 })
  assert.equal(a.resolution_rate, 50)
  assert.equal(a.escalation_rate, 25)
  assert.equal(a.cost_usd, 0.06, 't1 and t2; t3 unpriced')
  assert.equal(a.cost_per_task, 0.015)
  assert.equal(a.unpriced_requests, 1)
  assert.equal(a.requests_per_task, 1)
  // t1 10 minutes, t2 20 (from its first request to its last end), t3 10; t4 had no requests.
  assert.ok(Math.abs(a.avg_seconds - 800) <= 2, `avg ${a.avg_seconds}`)
  assert.deepEqual(s[other], { closed: 0, resolved: 0, escalated: 0, failed: 0, open: 0, resolution_rate: null, escalation_rate: null,
    cost_usd: null, cost_per_task: null, unpriced_requests: 0, requests_per_task: null, avg_seconds: null, versions: [] })
  assert.equal((await summaries(db, org, [agent], 90))[agent].closed, 5, 't6 within 90 days')
  assert.equal((await summaries(db, org, [agent], 1))[agent].closed, 4, 'a day, for whoever watches thresholds')
})

test('detail: why tasks were handed over, the last ones that ended, the open ones', { skip }, async () => {
  const d = await detail(db, org, agent, 30)
  assert.equal(d.summary.closed, 4)
  assert.deepEqual(d.reasons, [
    { outcome: 'escalated', reason: 'customer_asked_for_a_person', count: 1 },
    { outcome: 'failed', reason: 'crm_down', count: 1 },
  ])
  assert.deepEqual(d.recent.map(r => [r.task, r.outcome, r.requests]), [['t4', 'failed', 0], ['t3', 'escalated', 1], ['t1', 'resolved', 2], ['t2', 'resolved', 1]])
  assert.equal(d.recent[2].cost_usd, 0.04)
  assert.deepEqual(d.open.map(o => [o.task, o.requests]), [['t5', 1]])
})

test('by version: a change of instructions shows as a change of results', { skip }, async () => {
  const bot = (await sql(`INSERT INTO agents (org_id, team_id, name) VALUES ($1, $2, 'versioned') RETURNING id`, [org, team]))[0].id
  for (let i = 0; i < 4; i++) await end(bot, `a${i}`, ago(300 - i), i < 3 ? 'resolved' : 'escalated', null, 'v1')
  for (let i = 0; i < 2; i++) await end(bot, `b${i}`, ago(60 - i), i < 1 ? 'resolved' : 'escalated', null, 'v2')
  await end(bot, 'c0', ago(10), 'failed')
  const v = (await summaries(db, org, [bot], 1))[bot].versions
  assert.deepEqual(v.map(x => [x.version, x.closed, x.resolution_rate]), [[null, 1, 0], ['v2', 2, 50], ['v1', 4, 75]], 'most recent first')
  const d = await detail(db, org, bot, 1)
  assert.equal(d.versions.length, 3)
  assert.equal(d.summary.versions, undefined)
  assert.equal(d.recent.find(r => r.task === 'b0').agent_version, 'v2')
})

