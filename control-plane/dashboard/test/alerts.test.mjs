// Alerts that are sent (lib/alert-delivery.js).
//
//   DATABASE_URL=postgres://... node --import ./test/register.mjs --test test/
//
// The parts that need PostgreSQL are skipped without DATABASE_URL.

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

const {
  alertConfig, webhookProblem, reached, buildMessage, deliver, evaluateAlerts,
} = await import('../lib/alert-delivery.js')

const cfg = alertConfig({})

test('config: Slack by default, email only with an SMTP server', () => {
  assert.deepEqual(cfg.webhookHosts, ['hooks.slack.com'])
  assert.equal(cfg.smtpUrl, null)
  assert.equal(cfg.intervalS, 300)
  const c = alertConfig({ STRATUM_SMTP_URL: 'smtp://u:p@mail.acme.com:587', STRATUM_ALERT_WEBHOOK_HOSTS: 'hooks.slack.com, Outlook.Office.com',
    STRATUM_CONSOLE_URL: 'https://stratum.acme.com/', STRATUM_ALERTS_INTERVAL_S: '0' })
  assert.equal(c.from, 'alertas@mail.acme.com')
  assert.deepEqual(c.webhookHosts, ['hooks.slack.com', 'outlook.office.com'])
  assert.equal(c.consoleUrl, 'https://stratum.acme.com')
  assert.equal(c.intervalS, 0)
})

test('webhooks: https, to an allowed host, without credentials', () => {
  assert.equal(webhookProblem('https://hooks.slack.com/services/T/B/x', cfg), null)
  for (const url of ['http://hooks.slack.com/x', 'https://evil.example/x', 'https://169.254.169.254/', 'https://u:p@hooks.slack.com/x',
    'https://hooks.slack.com.evil.example/x', 'not a url']) {
    assert.ok(webhookProblem(url, cfg), url)
  }
})

const quotaAlert = { alert_type: 'quota', threshold_pct: 80, quota: '1000', team_name: 'Engineering', channel: 'slack', destination: 'https://hooks.slack.com/services/T/B/x' }

test('threshold and message', () => {
  assert.equal(reached(quotaAlert, { tokens: '799' }), null)
  const hit = reached(quotaAlert, { tokens: '850' })
  assert.deepEqual(hit, { used: 850, limit: 1000, pct: 85 })
  assert.equal(reached({ ...quotaAlert, quota: null }, { tokens: 5e9 }), null, 'no quota: nothing to compare with')
  assert.equal(reached({ ...quotaAlert, alert_type: 'budget', budget: '50' }, { cost: '40.5' }).pct, 81)

  const m = buildMessage(quotaAlert, hit, { now: new Date('2026-10-20T12:00:00Z'), consoleUrl: 'https://s.acme.com' })
  assert.equal(m.subject, '[Stratum] Engineering llegó al 85 % de su cuota de tokens de octubre')
  assert.match(m.text, /850 de 1\.000 tokens/)
  assert.match(m.text, /rechazan los pedidos/)
  assert.match(m.text, /https:\/\/s\.acme\.com\/teams/)
  const b = buildMessage({ ...quotaAlert, alert_type: 'budget', budget_enforced: false }, { used: 40.5, limit: 50, pct: 81 }, { now: new Date('2026-10-20') })
  assert.match(b.text, /US\$ 40,50 de US\$ 50,00/)
  assert.doesNotMatch(b.text, /rechazan/, 'a reference budget does not cut')
})

test('deliver: Slack payload, SMTP message, refusals', async () => {
  const posts = []
  const fetch = async (url, opts) => { posts.push({ url, opts }); return { ok: true, status: 200 } }
  await deliver(quotaAlert, { subject: 'S', text: 'T' }, cfg, { fetch })
  assert.equal(posts[0].url, quotaAlert.destination)
  assert.deepEqual(JSON.parse(posts[0].opts.body), { text: '*S*\nT' })
  assert.equal(posts[0].opts.redirect, 'error', 'a redirect could lead somewhere not allowed')

  await assert.rejects(deliver(quotaAlert, { subject: 'S', text: 'T' }, cfg, { fetch: async () => ({ ok: false, status: 404 }) }), /respondió 404/)
  await assert.rejects(deliver({ ...quotaAlert, destination: 'https://evil.example/x' }, { subject: 'S', text: 'T' }, cfg, { fetch }), /solo envía a hooks\.slack\.com/)
  assert.equal(posts.length, 1)

  const mails = []
  const email = { ...quotaAlert, channel: 'email', destination: 'fin@acme.com' }
  await assert.rejects(deliver(email, { subject: 'S', text: 'T' }, cfg), /STRATUM_SMTP_URL/)
  const smtp = alertConfig({ STRATUM_SMTP_URL: 'smtp://mail.acme.com', STRATUM_ALERT_FROM: 'stratum@acme.com' })
  await deliver(email, { subject: 'S', text: 'T' }, smtp, { transport: { sendMail: async m => mails.push(m) } })
  assert.deepEqual(mails, [{ from: 'stratum@acme.com', to: 'fin@acme.com', subject: 'S', text: 'T' }])
  // A server that never answers does not hold the round.
  await assert.rejects(deliver(email, { subject: 'S', text: 'T' }, smtp, { transport: { sendMail: () => new Promise(() => {}) }, timeoutMs: 50 }),
    /no respondió/)
})

// --- against PostgreSQL -----------------------------------------------------

const url = process.env.DATABASE_URL
const skip = url ? false : 'DATABASE_URL not set'
let db
const orgs = []
before(async () => { if (url) db = new (await import('pg')).default.Pool({ connectionString: url, max: 4 }) })
after(async () => {
  if (!db) return
  await db.query('DELETE FROM alerts WHERE org_id = ANY($1::uuid[])', [orgs]) // no cascade on alerts.org_id
  await db.query('DELETE FROM organizations WHERE id = ANY($1::uuid[])', [orgs])
  await db.end()
})
const sql = async (text, params = []) => (await db.query(text, params)).rows

async function fixture() {
  const org = randomUUID(); orgs.push(org)
  await sql('INSERT INTO organizations (id, name) VALUES ($1, $2)', [org, `al-${org.slice(0, 8)}`])
  const [p] = await sql(`INSERT INTO policies (org_id, name, monthly_token_quota, monthly_budget_usd) VALUES ($1, 'p', 1000, 10) RETURNING id`, [org])
  const [t] = await sql(`INSERT INTO teams (org_id, name, policy_id) VALUES ($1, 'Engineering', $2) RETURNING id`, [org, p.id])
  const usage = (tokens, cost, at = 'now()') => sql(
    `INSERT INTO request_logs (id, created_at, org_id, team_id, tokens_input, tokens_output, cost_usd, provider, model_id, status_code)
     VALUES ($1, ${at}, $2, $3, $4, 0, $5, 'openai', 'gpt-4o', 200)`, [randomUUID(), org, t.id, tokens, cost])
  const alert = async (type, pct, channel = 'slack', destination = 'https://hooks.slack.com/services/T/B/x') => (await sql(
    `INSERT INTO alerts (org_id, team_id, alert_type, threshold_pct, channel, destination) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [org, t.id, type, pct, channel, destination]))[0].id
  return { org, team: t.id, usage, alert }
}

const quiet = { error: () => {} }

test('evaluate: one message per alert and month, also with two replicas', { skip }, async () => {
  const f = await fixture()
  const q80 = await f.alert('quota', 80)
  const b50 = await f.alert('budget', 50)
  const q100 = await f.alert('quota', 100)
  await f.usage(10_000, 99, "date_trunc('month', now()) - interval '1 day'") // last month: not this month's usage
  await f.usage(850, 4)

  const posts = []
  const deps = { fetch: async (u, o) => { posts.push(JSON.parse(o.body).text); return { ok: true, status: 200 } } }
  const mine = r => r.filter(x => [q80, b50, q100].includes(x.id))
  // Two replicas in the same round: each alert is sent once.
  const [r1, r2] = await Promise.all([evaluateAlerts(db, { cfg, deps, log: quiet }), evaluateAlerts(db, { cfg, deps, log: quiet })])
  const sent = [...mine(r1), ...mine(r2)].filter(x => x.sent).map(x => x.id).sort()
  assert.deepEqual(sent, [q80].sort(), 'quota at 85 %: the 80 % alert; budget at 40 %, quota under 100 %: nothing else')
  assert.equal(posts.filter(p => p.includes('Engineering')).length, 1)

  await f.usage(200, 2) // 1050 tokens, US$ 6
  const r3 = mine(await evaluateAlerts(db, { cfg, deps, log: quiet }))
  assert.deepEqual(r3.filter(x => x.sent).map(x => x.id).sort(), [b50, q100].sort(), 'the 80 % alert does not repeat this month')
  assert.deepEqual(mine(await evaluateAlerts(db, { cfg, deps, log: quiet })), [])

  // Reiniciar: it may send again.
  await sql('UPDATE alerts SET last_fired_at = NULL WHERE id = $1', [q80])
  assert.equal(mine(await evaluateAlerts(db, { cfg, deps, log: quiet })).length, 1)
  // Sent last month: this month is another one.
  await sql(`UPDATE alerts SET last_fired_at = date_trunc('month', now()) - interval '2 days' WHERE id = $1`, [q80])
  assert.equal(mine(await evaluateAlerts(db, { cfg, deps, log: quiet })).length, 1)
})

test('evaluate: a failed send is recorded and tried again', { skip }, async () => {
  const f = await fixture()
  const a = await f.alert('quota', 50, 'email', 'fin@acme.com')
  await f.usage(600, 0)
  let r = (await evaluateAlerts(db, { cfg, log: quiet })).filter(x => x.id === a) // no SMTP configured
  assert.equal(r[0].sent, false)
  let [row] = await sql('SELECT last_fired_at, last_error FROM alerts WHERE id = $1', [a])
  assert.equal(row.last_fired_at, null, 'not marked as sent')
  assert.match(row.last_error, /STRATUM_SMTP_URL/)

  const mails = []
  const smtp = alertConfig({ STRATUM_SMTP_URL: 'smtp://mail.acme.com' })
  r = (await evaluateAlerts(db, { cfg: smtp, deps: { transport: { sendMail: async m => mails.push(m) } }, log: quiet })).filter(x => x.id === a)
  assert.equal(r[0].sent, true)
  ;[row] = await sql('SELECT last_fired_at, last_error FROM alerts WHERE id = $1', [a])
  assert.ok(row.last_fired_at)
  assert.equal(row.last_error, null)
  assert.equal(mails[0].to, 'fin@acme.com')
})

test('evaluate: inactive alerts and teams without a limit are skipped', { skip }, async () => {
  const f = await fixture()
  const a = await f.alert('quota', 10)
  await sql('UPDATE alerts SET is_active = false WHERE id = $1', [a])
  const b = await f.alert('budget', 10)
  await sql('UPDATE policies SET monthly_budget_usd = NULL WHERE org_id = $1', [f.org])
  await f.usage(900, 9)
  const r = (await evaluateAlerts(db, { cfg, deps: { fetch: async () => ({ ok: true }) }, log: quiet })).filter(x => [a, b].includes(x.id))
  assert.deepEqual(r, [])
})
