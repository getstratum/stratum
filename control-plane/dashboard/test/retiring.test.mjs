// Models that retire (migration 053, lib/retiring-models.js) and the models
// each organization's providers list every day (lib/provider-models.js).
//
//   DATABASE_URL=postgres://... node --import ./test/register.mjs --test test/
//
// Skipped without DATABASE_URL.

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'

process.env.STRATUM_ENCRYPTION_KEY ??= randomBytes(32).toString('hex')
const pg = (await import('pg')).default
const { closeDb } = await import('../lib/db.js')
const { encryptSecret } = await import('../lib/secrets.js')
const { retiringFor, evaluateRetiring, stageOf, retiringMessage } = await import('../lib/retiring-models.js')
const { refreshProviderModels } = await import('../lib/provider-models.js')
const { createPlatformToken } = await import('../lib/platform.js')
const { NextRequest } = await import('next/server.js')

const url = process.env.DATABASE_URL
const skip = url ? false : 'DATABASE_URL not set'
let db
const orgs = []
const sql = async (text, params = []) => (await db.query(text, params)).rows
const P = `rt${randomUUID().slice(0, 6)}`
const day = (n) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10)
const quiet = { error() {}, warn() {}, log() {} }

let A, B
async function org(name) {
  const id = randomUUID()
  orgs.push(id)
  await sql('INSERT INTO organizations (id, name) VALUES ($1, $2)', [id, name])
  const [pol] = await sql(`INSERT INTO policies (org_id, name, allowed_models) VALUES ($1, 'Soporte', ARRAY[$2, 'otro']) RETURNING id`,
    [id, `${P}/soon`])
  const [team] = await sql(`INSERT INTO teams (org_id, name, policy_id) VALUES ($1, 'Soporte', $2) RETURNING id`, [id, pol.id])
  const [eng] = await sql(`INSERT INTO teams (org_id, name) VALUES ($1, 'Eng') RETURNING id`, [id])
  await sql(`INSERT INTO users (org_id, team_id, email, role) VALUES ($1, NULL, $2, 'owner'), ($1, $3, $4, 'team_manager'), ($1, $5, $6, 'team_manager')`,
    [id, `own-${id.slice(0, 6)}@x.com`, team.id, `tm-${id.slice(0, 6)}@x.com`, eng.id, `eng-${id.slice(0, 6)}@x.com`])
  return { id, policy: pol.id, team: team.id, eng: eng.id }
}

before(async () => {
  if (!url) return
  db = new pg.Pool({ connectionString: url, max: 2 })
  await sql(`INSERT INTO ai_models (provider, model_id, display_name, aliases, cost_per_1k_input_tokens, cost_per_1k_output_tokens, deprecated_on)
             VALUES ($1, 'soon', 'Soon', ARRAY['soon-2025'], 0.001, 0.002, $2::date),
                    ($1, 'week', 'Week', '{}', 0.001, 0.002, $3::date),
                    ($1, 'later', 'Later', '{}', 0.001, 0.002, $4::date),
                    ($1, 'unused', 'Unused', '{}', 0.001, 0.002, $3::date)`,
  [P, day(20), day(5), day(90)])
  A = await org(`Acme ${P}`)
  B = await org(`Other ${P}`)
  // A route of A goes to "week"; Eng used "soon" by its alias.
  await sql(`INSERT INTO model_aliases (org_id, name, targets) VALUES ($1, 'rapido', $2::jsonb)`,
    [A.id, JSON.stringify([{ provider: P, model: 'week' }])])
  await sql(`INSERT INTO request_logs (org_id, team_id, provider, model_id, tokens_input, tokens_output, status_code, created_at)
             VALUES ($1, $2, $3, 'soon-2025', 10, 10, 200, now() - interval '2 days')`, [A.id, A.eng, P])
})

after(async () => {
  if (!db) return
  await sql('DELETE FROM request_logs WHERE org_id = ANY($1::uuid[])', [orgs])
  await sql('DELETE FROM organizations WHERE id = ANY($1::uuid[])', [orgs])
  await sql('DELETE FROM ai_models WHERE provider = $1', [P])
  await db.end()
  await closeDb()
})

test('retiring: the stage of a notice', () => {
  assert.deepEqual([stageOf(40), stageOf(31), stageOf(8), stageOf(7), stageOf(0), stageOf(-3)], [null, 'month', 'month', 'week', 'week', 'week'])
  const m = retiringMessage('Acme', [{ provider: 'openai', model_id: 'gpt-4o-mini', deprecated_on: '2027-01-14', days: 49, policies: ['Marketing'], routes: [], used: 12, teams: [] }])
  assert.match(m.subject, /gpt-4o-mini se retira el 14 de enero de 2027/)
  assert.match(m.text, /Políticas que lo nombran: Marketing\./)
  assert.match(m.text, /Pedidos en los últimos 30 días: 12\./)
})

test('retiring: what touches an organization: a policy, a route or its use; who is told, once per step', { skip }, async () => {
  const list = await retiringFor(db, A.id)
  const ours = list.filter(m => m.provider === P)
  assert.deepEqual(ours.map(m => m.model_id), ['week', 'soon'], 'soonest first; unused and later are not there')
  const soon = ours.find(m => m.model_id === 'soon')
  assert.deepEqual(soon.policies, ['Soporte'])
  assert.equal(soon.used, 1, 'by its alias')
  assert.deepEqual(soon.teams.map(t => t.name).sort(), ['Eng', 'Soporte'])
  assert.deepEqual(ours.find(m => m.model_id === 'week').routes, ['rapido'])
  assert.deepEqual((await retiringFor(db, B.id)).filter(m => m.provider === P).map(m => m.model_id), ['soon'], 'B only names it')

  const sent = []
  const cfg = { smtpUrl: 'smtp://x', from: 'alertas@x', consoleUrl: 'https://consola.x', webhookHosts: [] }
  const deps = { transport: { sendMail: async m => sent.push(m) } }
  const run = async (today) => (await evaluateRetiring(db, { cfg, deps, log: quiet, today })).filter(r => r.orgId === A.id)
  const [first] = await run(new Date())
  assert.deepEqual(first.models.sort(), [`${P}/soon`, `${P}/week`])
  const toA = sent.filter(m => /Acme/.test(m.subject) || m.text.includes(`Acme ${P}`))
  assert.deepEqual(toA.map(m => m.to).sort(), [`eng-${A.id.slice(0, 6)}@x.com`, `own-${A.id.slice(0, 6)}@x.com`, `tm-${A.id.slice(0, 6)}@x.com`])
  assert.match(toA[0].text, /stratum\/rapido/)
  assert.match(toA[0].text, /https:\/\/consola\.x\/models/)
  assert.equal((await run(new Date())).length, 0, 'once')
  // "soon" a week before: told again; "week" already was.
  const [again] = await run(new Date(Date.now() + 14 * 86_400_000))
  assert.deepEqual(again.models, [`${P}/soon`])
})

test('provider models: listed every day for each enabled provider it can test; a failure does not stop the rest', { skip }, async () => {
  await sql(`INSERT INTO provider_configs (id, org_id, provider, display_name, api_key_encrypted)
             VALUES ($1, $2, 'openai', 'OpenAI', $3), ($4, $5, 'anthropic', 'Anthropic', $3)`,
  [`pc_${randomUUID().replace(/-/g, '')}`, A.id, encryptSecret('sk-a'), `pc_${randomUUID().replace(/-/g, '')}`, B.id])
  const asked = []
  const test = async (provider, key) => {
    asked.push(`${provider}:${key}`)
    if (provider === 'anthropic') return { ok: false, status: 401, message: 'invalid key' }
    return { ok: true, ids: ['gpt-nuevo', 'gpt-4o'], kinds: { 'gpt-nuevo': 'chat' }, capabilities: { 'gpt-nuevo': { vision: true, tools: true } } }
  }
  const r = (await refreshProviderModels(db, { test })).filter(x => [A.id, B.id].includes(x.orgId))
  assert.deepEqual(r.map(x => [x.provider, x.ok]).sort(), [['anthropic', false], ['openai', true]])
  assert.ok(asked.includes('openai:sk-a'))
  const rows = await sql(`SELECT model_id, kind, vision FROM provider_models WHERE org_id = $1 ORDER BY 1`, [A.id])
  assert.deepEqual(rows.map(x => [x.model_id, x.kind, x.vision]), [['gpt-4o', null, null], ['gpt-nuevo', 'chat', true]])

  // The platform hears which listed models the catalog lacks, never whose.
  const { raw } = await createPlatformToken(db, { name: `catalogador ${P}`, days: 1 })
  const { GET } = await import('../app/api/platform/models/route.js')
  const res = await GET(new NextRequest('http://console.test/api/platform/models', { headers: { authorization: `Bearer ${raw}` } }), { params: Promise.resolve({}) })
  assert.equal(res.status, 200)
  const { models } = await res.json()
  const nuevo = models.find(m => m.provider === 'openai' && m.model_id === 'gpt-nuevo')
  assert.ok(nuevo && nuevo.organizations >= 1 && nuevo.kind === 'chat')
  assert.ok(!JSON.stringify(nuevo).includes(A.id))
  const unauth = await GET(new NextRequest('http://console.test/api/platform/models'), { params: Promise.resolve({}) })
  assert.equal(unauth.status, 401)
})
