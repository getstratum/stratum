// Labels an application puts on its requests (X-Stratum-Labels, migration
// 029): stored apart from PII findings, and a dimension of Consumo.
//
//   DATABASE_URL=postgres://... node --import ./test/register.mjs --test test/
//
// Skipped without DATABASE_URL.

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID, randomBytes } from 'node:crypto'

const { NextRequest } = await import('next/server.js')
const pg = (await import('pg')).default
const { closeDb } = await import('../lib/db.js')
const { hashSyncToken } = await import('../lib/instance-auth.js')
const { normalizeRecord } = await import('../lib/usage-ingest.js')
const { consumption, parseQuery } = await import('../lib/consumption.js')
const ingest = await import('../app/api/internal/usage/route.js')

const url = process.env.DATABASE_URL
const skip = url ? false : 'DATABASE_URL not set'
let db
const orgs = []
const sql = async (text, params = []) => (await db.query(text, params)).rows

before(() => { if (url) db = new pg.Pool({ connectionString: url, max: 2 }) })
after(async () => {
  if (!db) return
  await sql('DELETE FROM request_logs WHERE org_id = ANY($1::uuid[])', [orgs])
  await sql('DELETE FROM organizations WHERE id = ANY($1::uuid[])', [orgs])
  await db.end()
  await closeDb()
})

const base = {
  id: randomUUID(), ts: '2026-10-16T11:59:00Z', key_id: 'k', status: 200, stream: false,
  duration_ms: 1, upstream_ms: 1, tokens_in: 1, tokens_out: 1,
}

test('labels: checked like content flags, at most 8', () => {
  const now = Date.parse('2026-10-16T12:00:00Z')
  assert.equal(normalizeRecord({ ...base, labels: ['topic_legal', 'eval_warned', 'topic_legal'] }, now).labels, 'eval_warned,topic_legal')
  assert.equal(normalizeRecord(base, now).labels, '')
  assert.equal(normalizeRecord({ ...base, labels: ['Topic'] }, now), null)
  assert.equal(normalizeRecord({ ...base, labels: 'topic_legal' }, now), null)
  assert.equal(normalizeRecord({ ...base, labels: Array.from({ length: 9 }, (_, i) => `l${i}`) }, now), null)
  assert.throws(() => parseQuery(new URLSearchParams('by=team&label=Not%20valid')), /label/)
  assert.deepEqual(parseQuery(new URLSearchParams('by=user&label=topic_legal')).filter, { kind: 'label', value: 'topic_legal' })
})

test('labels: stored apart from PII findings, and grouped in Consumo', { skip }, async () => {
  const org = randomUUID()
  orgs.push(org)
  await sql('INSERT INTO organizations (id, name) VALUES ($1, $2)', [org, `l-${org.slice(0, 8)}`])
  const [team] = await sql(`INSERT INTO teams (org_id, name) VALUES ($1, 'Eng') RETURNING id`, [org])
  const [user] = await sql(`INSERT INTO users (org_id, team_id, email, name) VALUES ($1, $2, $3, 'Ana') RETURNING id`,
    [org, team.id, `ana-${org.slice(0, 8)}@example.com`])
  const token = `dp_sync_${randomBytes(32).toString('hex')}`
  const instance = `dp_${randomBytes(16).toString('hex')}`
  await sql('INSERT INTO data_plane_instances (id, org_id, name, sync_token_hash) VALUES ($1, $2, $3, $4)',
    [instance, org, 'gw', hashSyncToken(token)])

  const rec = (labels, extra = {}) => ({
    id: randomUUID(), ts: new Date().toISOString(), key_id: user.id, team_id: team.id,
    provider: 'openai', model: 'gpt-4o-mini', status: 200, reason: 'ok', stream: false,
    duration_ms: 500, upstream_ms: 400, tokens_in: 100, tokens_out: 50, labels, ...extra,
  })
  const legal = rec(['topic_legal'])
  const both = rec(['topic_legal', 'eval_warned'])
  const code = rec(['topic_code'], { content_flags: ['email'] })
  const none = rec(undefined)
  const res = await ingest.POST(new NextRequest('http://console.test/api/internal/usage', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ instance_id: instance, records: [legal, both, code, none] }),
  }), { params: Promise.resolve({}) })
  assert.equal(res.status, 200)

  const row = async r => (await sql('SELECT labels, pii_flagged, pii_types FROM request_logs WHERE id = $1', [r.id]))[0]
  assert.deepEqual(await row(both), { labels: ['eval_warned', 'topic_legal'], pii_flagged: false, pii_types: [] })
  assert.deepEqual(await row(code), { labels: ['topic_code'], pii_flagged: true, pii_types: ['email'] })
  assert.deepEqual((await row(none)).labels, [])

  const session = { orgId: org, scope: 'org' }
  const from = new Date(Date.now() - 86400000), to = new Date(Date.now() + 86400000)
  const byLabel = await consumption(db, session, { from, to, by: 'label', filter: null })
  const counts = Object.fromEntries(byLabel.rows.map(r => [r.key, r.requests]))
  assert.deepEqual(counts, { topic_legal: 2, eval_warned: 1, topic_code: 1 })
  assert.equal(byLabel.totals.requests, 3, 'totals: requests with any label, each once')
  assert.equal(byLabel.rows.find(r => r.key === 'topic_legal').label, 'topic_legal')
  assert.ok(byLabel.days.every(d => d.key), 'daily series per label')

  const legalPeople = await consumption(db, session, { from, to, by: 'user', filter: { kind: 'label', value: 'topic_legal' } })
  assert.equal(legalPeople.totals.requests, 2)
  assert.equal(legalPeople.rows[0].label, 'Ana')
})
