// A policy's default model (H-09; lib/default-model.js, migration 039): what
// may be one, what the console says of it, what gateways get, and who is told
// when it stops working as set (lib/default-model-notices.js).
//
//   DATABASE_URL=postgres://... node --import ./test/register.mjs --test test/
//
// Skipped without DATABASE_URL.

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID, createHash } from 'node:crypto'

const { NextRequest } = await import('next/server.js')
const pg = (await import('pg')).default
const { hashPassword } = await import('../lib/password.js')
const { closeDb } = await import('../lib/db.js')
const { buildSyncResponse } = await import('../lib/sync.js')
const { defaultState, whyNot, parseDefault } = await import('../lib/default-model.js')
const { evaluateDefaults, noticeMessage } = await import('../lib/default-model-notices.js')
const { ingest } = await import('../lib/usage-ingest.js')

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
  const tag = id.slice(0, 8)
  orgs.push(id)
  await sql('INSERT INTO organizations (id, name) VALUES ($1, $2)', [id, `d-${tag}`])
  const [team] = await sql(`INSERT INTO teams (org_id, name) VALUES ($1, 'Soporte') RETURNING id`, [id])
  const [other] = await sql(`INSERT INTO teams (org_id, name) VALUES ($1, 'Ventas') RETURNING id`, [id])
  for (const provider of ['openai', 'groq']) {
    await sql(`INSERT INTO provider_configs (id, org_id, provider, display_name, api_key_encrypted, enabled)
               VALUES ($1, $2, $3, $3, 'x', true)`, [`pc_${provider}_${tag}`, id, provider])
  }
  const hash = await hashPassword(PASSWORD)
  const out = { id, tag, team: team.id, other: other.id, emails: {} }
  for (const [role, teamId] of [['admin', team.id], ['team_manager', team.id], ['member', team.id], ['team_manager', other.id]]) {
    const email = `${role}-${teamId === team.id ? 's' : 'v'}-${tag}@example.com`
    await sql(`INSERT INTO users (org_id, team_id, email, role, password_hash) VALUES ($1, $2, $3, $4, $5)`, [id, teamId, email, role, hash])
    out.emails[`${role}${teamId === team.id ? '' : '_other'}`] = email
    if (role !== 'admin') continue
    const r = await (await import('../app/api/session/route.js')).POST(new NextRequest('http://console.test/api/session', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: PASSWORD }),
    }))
    const cookie = r.cookies.get('stratum_session').value
    await sql('UPDATE console_sessions SET enrollment_only = false WHERE token_hash = $1',
      [createHash('sha256').update(cookie).digest('hex')])
    out.admin = cookie
  }
  // A route with a second model (Modelos → Rutas).
  await sql(`INSERT INTO model_aliases (org_id, name, targets) VALUES ($1, 'chat', $2)`,
    [id, JSON.stringify([{ provider: 'openai', model: 'gpt-4o-mini' }, { provider: 'groq', model: 'llama-3.3-70b-versatile' }])])
  return out
}

let A
before(async () => {
  if (!url) return
  db = new pg.Pool({ connectionString: url, max: 3 })
  A = await org()
})
after(async () => {
  if (!db) return
  await sql('DELETE FROM alerts WHERE org_id = ANY($1::uuid[])', [orgs])
  await sql('DELETE FROM organizations WHERE id = ANY($1::uuid[])', [orgs])
  await db.end()
  await closeDb()
})

// ─── Without a database ─────────────────────────────────────────────────────

const ctx = {
  providers: new Set(['openai', 'groq']),
  catalog: [
    { provider: 'openai', model_id: 'gpt-4o-mini', aliases: [], kind: null, active: true, enabled: true },
    { provider: 'openai', model_id: 'gpt-4o', aliases: [], kind: null, active: true, enabled: false },
    { provider: 'openai', model_id: 'gpt-3.5-turbo', aliases: [], kind: null, active: false, enabled: true },
  ],
  listed: [{ provider: 'groq', model_id: 'whisper-large-v3', kind: null, enabled: true }],
  aliases: new Map([['chat', [{ provider: 'openai', model: 'gpt-4o-mini' }, { provider: 'groq', model: 'llama-3.3-70b-versatile' }]]]),
}
const all = { allow_all_models: true, allowed_models: [], allowed_providers: null }

test('parseDefault: a model or a route', () => {
  assert.deepEqual(parseDefault('stratum/chat'), { route: 'chat' })
  assert.deepEqual(parseDefault('groq/meta-llama/llama-4'), { provider: 'groq', model: 'meta-llama/llama-4' })
  assert.equal(parseDefault(null), null)
})

test('whyNot: what keeps a policy from using a model', () => {
  assert.equal(whyNot(all, ctx, 'openai', 'gpt-4o-mini'), null)
  assert.match(whyNot(all, ctx, 'mistral', 'large'), /mistral no está configurado/)
  assert.match(whyNot({ ...all, allowed_providers: ['groq'] }, ctx, 'openai', 'gpt-4o-mini'), /no permite openai/)
  assert.match(whyNot({ allow_all_models: false, allowed_models: ['gpt-4o'] }, ctx, 'openai', 'gpt-4o-mini'), /no permite openai\/gpt-4o-mini/)
  assert.equal(whyNot({ allow_all_models: false, allowed_models: ['openai/gpt-4o-mini'] }, ctx, 'openai', 'gpt-4o-mini'), null)
  assert.match(whyNot(all, ctx, 'openai', 'gpt-4o'), /apagado en la organización/)
  assert.match(whyNot(all, ctx, 'openai', 'gpt-3.5-turbo'), /se retiró del catálogo/)
  assert.match(whyNot(all, ctx, 'groq', 'whisper-large-v3'), /no es un modelo de chat/)
})

test('defaultState: ok, a route without its first model, unusable', () => {
  assert.equal(defaultState({ ...all, default_model: null }, ctx).state, 'none')
  assert.deepEqual(defaultState({ ...all, default_model: 'openai/gpt-4o-mini' }, ctx),
    { state: 'ok', detail: '', to: 'openai/gpt-4o-mini', route: null, fallback: false })
  const route = defaultState({ ...all, default_model: 'stratum/chat' }, ctx)
  assert.deepEqual([route.state, route.to, route.fallback], ['ok', 'openai/gpt-4o-mini', true])
  const degraded = defaultState({ ...all, allowed_providers: ['groq'], default_model: 'stratum/chat' }, ctx)
  assert.deepEqual([degraded.state, degraded.to, degraded.fallback], ['degraded', 'groq/llama-3.3-70b-versatile', false])
  assert.match(degraded.detail, /la política no permite openai: los pedidos van a groq\/llama-3.3-70b-versatile/)
  assert.equal(defaultState({ ...all, default_model: 'stratum/nope' }, ctx).state, 'unusable')
  assert.equal(defaultState({ ...all, default_model: 'openai/gpt-4o' }, ctx).state, 'unusable')
})

test('noticeMessage: what people are told', () => {
  const p = { name: 'Soporte', default_model: 'stratum/chat' }
  const m = noticeMessage(p, 'falling_back', 'el proveedor falla.', ['Soporte'], { consoleUrl: 'https://c' })
  assert.equal(m.subject, '[Stratum] El modelo predeterminado de Soporte está usando su segundo modelo')
  assert.match(m.text, /Equipos con esta política: Soporte\./)
  assert.match(m.text, /https:\/\/c\/policy/)
  assert.match(noticeMessage(p, 'ok', '', [], { recovered: true }).subject, /volvió a funcionar/)
})

// ─── With the console ───────────────────────────────────────────────────────

test('policies: a default the policy can use is saved; one it cannot is refused, also by a later change', { skip }, async () => {
  const bad = await call('policies', 'POST', { as: A.admin, body: { name: 'x', allowAllModels: true, defaultModel: 'mistral/large' } })
  assert.equal(bad.status, 400)
  assert.match(bad.body.message, /mistral no está configurado/)
  assert.equal((await call('policies', 'POST', { as: A.admin, body: { name: 'x', allowAllModels: true, defaultModel: 'nada' } })).status, 400)

  const created = await call('policies', 'POST', { as: A.admin, body: {
    name: 'Soporte', allowAllModels: false, allowedModels: ['openai/gpt-4o-mini', 'groq/llama-3.3-70b-versatile'], defaultModel: 'stratum/chat' } })
  assert.equal(created.status, 201)
  const id = created.body.id
  await sql('UPDATE teams SET policy_id = $1 WHERE id = $2', [id, A.team])

  // Taking its first model away: saved, with the route going to the second.
  assert.equal((await call('policies/[id]', 'PATCH', { as: A.admin, params: { id }, body: { allowedModels: ['groq/llama-3.3-70b-versatile'] } })).status, 200)
  let p = (await call('policies', 'GET', { as: A.admin })).body.find(x => x.id === id)
  assert.deepEqual([p.default_model, p.default_state.state, p.default_state.to], ['stratum/chat', 'degraded', 'groq/llama-3.3-70b-versatile'])
  // Taking the last one: refused, the default would not work.
  const last = await call('policies/[id]', 'PATCH', { as: A.admin, params: { id }, body: { allowedModels: ['openai/gpt-4o'] } })
  assert.equal(last.status, 400)
  assert.match(last.body.message, /deja de servir/)

  // A route that is some policy's default cannot be deleted.
  const del = await call('model-aliases/[name]', 'DELETE', { as: A.admin, params: { name: 'chat' } })
  assert.equal(del.status, 409)
  assert.match(del.body.message, /predeterminado de: Soporte/)

  // Gateways get it with the policy.
  const client = await db.connect()
  try {
    const sync = JSON.parse(JSON.stringify(await buildSyncResponse(client, { orgId: A.id, sinceVersion: 0, syncIntervalS: 30, decrypt: v => v, warn: () => {} })))
    assert.equal(sync.policies.find(x => x.team_id === A.team).default_model, 'stratum/chat')
    assert.equal(sync.policies.find(x => x.team_id === A.other).default_model, '', 'a team without that policy')
  } finally {
    client.release()
  }

  // Cleared.
  assert.equal((await call('policies/[id]', 'PATCH', { as: A.admin, params: { id }, body: { allowedModels: ['openai/gpt-4o-mini', 'groq/llama-3.3-70b-versatile'], defaultModel: null } })).status, 200)
  p = (await call('policies', 'GET', { as: A.admin })).body.find(x => x.id === id)
  assert.deepEqual([p.default_model, p.default_state.state], [null, 'none'])
  await sql('UPDATE policies SET default_model = $2 WHERE id = $1', [id, 'stratum/chat'])
  A.policy = id
})

test('notices: who is told when the default stops working as set, and when it works again', { skip }, async () => {
  // Other files' organizations may have defaults too: only this one's mail.
  const sent = []
  const ours = () => sent.filter(m => m.to.includes(A.tag))
  const cfg = { smtpUrl: 'smtp://x', from: 'alertas@x', consoleUrl: null, webhookHosts: [] }
  const deps = { transport: { sendMail: async m => sent.push(m) } }
  const quiet = { error: () => {} }
  const mine = async () => (await evaluateDefaults(db, { cfg, deps, log: quiet })).filter(r => r.policyId === A.policy)
  const notice = async () => (await sql('SELECT state, notified_state FROM default_model_notices WHERE policy_id = $1', [A.policy]))[0]
  // A team alert of this type gets it too, by its own channel.
  await sql(`INSERT INTO alerts (org_id, team_id, alert_type, channel, destination) VALUES ($1, $2, 'default_model', 'email', $3)`, [A.id, A.team, `soporte-${A.tag}@example.com`])

  assert.deepEqual(await mine(), [], 'working as set: nothing to tell')
  assert.deepEqual(await notice(), { state: 'ok', notified_state: null })

  // Its first model turned off for the organization.
  await sql(`INSERT INTO org_model_settings (org_id, provider, model_id, enabled) VALUES ($1, 'openai', 'gpt-4o-mini', false)`, [A.id])
  const [degraded] = await mine()
  assert.deepEqual([degraded.state, degraded.sent], ['degraded', 3])
  // The admin, the team's manager and the alert; not a member, nor the
  // manager of a team with another policy.
  assert.deepEqual(ours().map(m => m.to).sort(), [A.emails.admin, A.emails.team_manager, `soporte-${A.tag}@example.com`].sort())
  assert.match(ours()[0].subject, /no puede usar su primer modelo/)
  assert.deepEqual(await notice(), { state: 'degraded', notified_state: 'degraded' })
  assert.deepEqual(await mine(), [], 'told once')

  // Traffic: the provider of its second model fails too and requests go on;
  // within 24 hours of the last notice nothing more is sent.
  await sql(`DELETE FROM org_model_settings WHERE org_id = $1`, [A.id])
  const [instance] = await sql(`INSERT INTO data_plane_instances (id, org_id, name, sync_token_hash) VALUES ($1, $2, 'gw', $3) RETURNING id, org_id`,
    [`dp_${randomUUID().replaceAll('-', '')}`, A.id, randomUUID()])
  const record = fell => ({ id: randomUUID(), ts: new Date().toISOString(), key_id: 'k', team_id: A.team, provider: 'groq',
    model: 'llama-3.3-70b-versatile', status: 200, reason: 'ok', stream: false, duration_ms: 1, upstream_ms: 1, tokens_in: 1, tokens_out: 1,
    flags: '', labels: fell ? 'routed_fallback' : '', alias: 'chat', request_id: null, user_id: null })
  await ingest(db, instance, [record(true), record(true), record(false)])
  sent.length = 0
  assert.deepEqual(await mine(), [])
  assert.equal((await notice()).state, 'falling_back')
  const shown = (await call('policies', 'GET', { as: A.admin })).body.find(x => x.id === A.policy)
  assert.equal(shown.default_state.state, 'falling_back')
  assert.match(shown.default_state.detail, /2 de 3 pedidos a stratum\/chat/)

  // Over 24 hours later, still falling back: told.
  await sql(`UPDATE default_model_notices SET notified_at = now() - interval '25 hours' WHERE policy_id = $1`, [A.policy])
  const [falling] = await mine()
  assert.deepEqual([falling.state, falling.recovered], ['falling_back', false])
  assert.match(ours()[0].subject, /usando su segundo modelo/)

  // Works again: told once.
  await sql(`DELETE FROM request_logs WHERE org_id = $1`, [A.id])
  sent.length = 0
  const [back] = await mine()
  assert.deepEqual([back.state, back.recovered], ['ok', true])
  assert.match(ours()[0].subject, /volvió a funcionar/)
  assert.deepEqual(await notice(), { state: 'ok', notified_state: 'ok' })
  assert.deepEqual(await mine(), [])

  // Unusable is told at once, even within 24 hours of the last notice.
  await sql(`UPDATE provider_configs SET enabled = false WHERE org_id = $1`, [A.id])
  await sql(`UPDATE default_model_notices SET notified_state = 'degraded', notified_at = now() WHERE policy_id = $1`, [A.policy])
  sent.length = 0
  const [unusable] = await mine()
  assert.equal(unusable.state, 'unusable')
  assert.match(ours()[0].subject, /no se puede usar/)
  await sql(`UPDATE provider_configs SET enabled = true WHERE org_id = $1`, [A.id])
})
