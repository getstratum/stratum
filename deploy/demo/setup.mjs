// The demo's data: DEMO ONLY, never for an installation people use.
//
// Runs once in the control plane's image (/app/demo/setup.mjs, see
// docker-compose.yml), after the migrations; running it again changes
// nothing. It loads the demo organization (control-plane/seed/demo.sql) and
// adds, with fixed passwords and keys:
//
//   owner@acme.com     Owner (sets up the second factor at the first sign-in)
//   auditor@acme.com   Auditor: reads everything, changes nothing, no second factor
//   three teams with their policies, four people with keys, two agents,
//   OpenAI and Mistral pointed at the mock LLM, the demo gateway,
//   and four weeks of usage history, reported the way a gateway does.
//
// Env: DATABASE_URL, STRATUM_ENCRYPTION_KEY, STRATUM_CP_URL (for the
// history), STRATUM_APP_DIR (default /app).

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const APP = process.env.STRATUM_APP_DIR ?? '/app'
const require = createRequire(`${APP}/package.json`)
const pg = require('pg')
process.removeAllListeners('warning')
const { hashPassword } = await import(`${APP}/lib/password.js`)
const { encryptSecret } = await import(`${APP}/lib/secrets.js`)

const sha = s => createHash('sha256').update(s).digest('hex')

export const ORG = '00000000-0000-0000-0000-000000000001'
export const TEAMS = {
  eng: '20000000-0000-0000-0000-000000000001',
  mkt: '20000000-0000-0000-0000-000000000002',
  sup: '20000000-0000-0000-0000-000000000003',
}
export const PEOPLE = [
  { id: '30000000-0000-0000-0000-000000000001', email: 'dev@acme.com', name: 'Dev User', team: TEAMS.eng },
  { id: '30000000-0000-0000-0000-000000000002', email: 'marketing@acme.com', name: 'Marketing User', team: TEAMS.mkt },
  { id: '30000000-0000-0000-0000-000000000003', email: 'ana@acme.com', name: 'Ana Pérez', team: TEAMS.eng },
  { id: '30000000-0000-0000-0000-000000000004', email: 'lucas@acme.com', name: 'Lucas Silva', team: TEAMS.sup },
].map(p => ({ ...p, key: `aig_sk_demo_${sha(`demo-key-${p.email}`).slice(0, 40)}` }))
export const AGENTS = [
  { id: '40000000-0000-0000-0000-000000000001', name: 'bot-soporte', team: TEAMS.sup, description: 'Responde tickets de soporte' },
  { id: '40000000-0000-0000-0000-000000000002', name: 'resumen-diario', team: TEAMS.eng, description: 'Resume los incidentes del día' },
].map(a => ({ ...a, key: `aig_agt_demo_${sha(`demo-key-${a.name}`).slice(0, 40)}` }))
export const GATEWAY = {
  id: 'dp_00000000000000000000000000000001',
  // The same as STRATUM_SYNC_TOKEN in docker-compose.yml.
  token: 'dp_sync_ec04306ae2ed29a95834cb9b70b9d7f0a8698db0df6f19ff70b925c8aed0cb29',
}
const ACCOUNTS = [
  { email: 'owner@acme.com', name: 'Owner (demo)', role: 'owner', password: 'stratum-demo-owner' },
  { email: 'auditor@acme.com', name: 'Auditor (demo)', role: 'auditor', password: 'stratum-demo-auditor' },
]
const MOCK = process.env.STRATUM_DEMO_MOCK_URL ?? 'http://mock-llm:8080'

async function setup(db) {
  await db.query(readFileSync(process.env.STRATUM_DEMO_SEED ?? `${APP}/demo/seed.sql`, 'utf8'))
  await db.query('BEGIN')
  try {
    // Policies: what each team may use. Engineering has instructions for
    // people (shown by applications that act for them).
    await db.query(`
      INSERT INTO policies (id, org_id, name, allowed_models, monthly_token_quota, monthly_budget_usd, pii_action, dlp_action)
      VALUES ('10000000-0000-0000-0000-000000000003', $1, 'Soporte Policy',
              ARRAY['gpt-4o-mini', 'mistral-small-latest'], 8000000, 80, 'redact', 'block')
      ON CONFLICT DO NOTHING`, [ORG])
    await db.query(`
      UPDATE policies SET allow_all_models = false, pii_action = 'redact', dlp_action = 'block', monthly_token_quota = 30000000,
             allowed_models = ARRAY['gpt-4o', 'gpt-4o-mini', 'gpt-5.4', 'mistral-small-latest',
                                    'claude-sonnet-4-6', 'claude-haiku-4-5-20251001', 'gemini-3.5-flash']
       WHERE id = '10000000-0000-0000-0000-000000000001'`)
    await db.query(`UPDATE policies SET allowed_models = ARRAY['gpt-4o-mini', 'claude-haiku-4-5-20251001'], monthly_token_quota = 5000000
                     WHERE id = '10000000-0000-0000-0000-000000000002'`)
    const { rows: col } = await db.query(`SELECT 1 FROM information_schema.columns
                                          WHERE table_name = 'policies' AND column_name = 'people_instructions'`)
    if (col.length) {
      await db.query(`UPDATE policies SET people_instructions = $1 WHERE id = '10000000-0000-0000-0000-000000000001'`,
        ['Si falta contexto para responder bien, preguntá antes de responder. Citá la fuente cuando la haya.'])
    }
    await db.query(`
      INSERT INTO teams (id, org_id, policy_id, name, department, monthly_budget_usd)
      VALUES ($1, $2, '10000000-0000-0000-0000-000000000003', 'Soporte', 'Operaciones', 80)
      ON CONFLICT DO NOTHING`, [TEAMS.sup, ORG])

    // People with developer keys; the two console accounts.
    for (const p of PEOPLE) {
      await db.query(`
        INSERT INTO users (id, org_id, team_id, email, name, role) VALUES ($1, $2, $3, $4, $5, 'member')
        ON CONFLICT DO NOTHING`, [p.id, ORG, p.team, p.email, p.name])
      await db.query('UPDATE users SET api_key_hash = $2, api_key_prefix = $3 WHERE id = $1 AND api_key_hash IS DISTINCT FROM $2',
        [p.id, sha(p.key), `${p.key.slice(0, 16)}...`])
    }
    for (const a of ACCOUNTS) {
      const { rows } = await db.query('SELECT id FROM users WHERE lower(email) = $1', [a.email])
      if (rows.length) continue
      await db.query(`INSERT INTO users (org_id, email, name, role, password_hash) VALUES ($1, $2, $3, $4, $5)`,
        [ORG, a.email, a.name, a.role, await hashPassword(a.password)])
    }
    for (const a of AGENTS) {
      await db.query(`
        INSERT INTO agents (id, org_id, team_id, name, description, api_key_hash, api_key_prefix)
        VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT DO NOTHING`,
      [a.id, ORG, a.team, a.name, a.description, sha(a.key), `${a.key.slice(0, 17)}...`])
    }

    // Providers: OpenAI and Mistral, both answered by the mock LLM.
    for (const [id, provider, name] of [['pc_demo_openai', 'openai', 'OpenAI (simulado)'], ['pc_demo_mistral', 'mistral', 'Mistral (simulado)']]) {
      await db.query(`
        INSERT INTO provider_configs (id, org_id, provider, display_name, api_key_encrypted, base_url, api_key_hint, key_updated_by, key_updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, 'demo', 'demo', now()) ON CONFLICT DO NOTHING`,
      [id, ORG, provider, name, encryptSecret('demo-not-a-real-key'), MOCK])
    }

    // The demo gateway, with a fixed sync token.
    await db.query(`
      INSERT INTO data_plane_instances (id, org_id, name, sync_token_hash) VALUES ($1, $2, 'demo', $3)
      ON CONFLICT DO NOTHING`, [GATEWAY.id, ORG, sha(GATEWAY.token)])
    await db.query('COMMIT')
  } catch (err) {
    await db.query('ROLLBACK')
    throw err
  }
}

// ── Four weeks of history, reported as a gateway reports usage ────────────

// A small seeded generator, so every demo looks the same.
function rng(seed) {
  let s = seed >>> 0
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32)
}
function uuid(r) {
  const h = Array.from({ length: 32 }, () => Math.floor(r() * 16).toString(16)).join('')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`
}

// Who uses what, and how much. Ollama is a local model: no price and no
// impact estimate, which the console shows as such.
const MIX = [
  { key: 'dev', provider: 'openai', model: 'gpt-4o', weight: 6, out: 600, labels: ['feature_codigo'] },
  { key: 'dev', provider: 'anthropic', model: 'claude-sonnet-4-6', weight: 5, out: 900, labels: ['feature_codigo'] },
  { key: 'ana', provider: 'openai', model: 'gpt-5.4', weight: 3, out: 1200, labels: ['feature_analisis'] },
  { key: 'ana', provider: 'gemini', model: 'gemini-3.5-flash', weight: 3, out: 500, labels: ['feature_analisis'] },
  { key: 'marketing', provider: 'openai', model: 'gpt-4o-mini', weight: 6, out: 400, labels: ['topic_campanas'] },
  { key: 'marketing', provider: 'anthropic', model: 'claude-haiku-4-5-20251001', weight: 3, out: 350, labels: ['topic_campanas'] },
  { key: 'bot-soporte', provider: 'openai', model: 'gpt-4o-mini', weight: 10, out: 250, labels: ['topic_soporte'] },
  { key: 'bot-soporte', provider: 'mistral', model: 'mistral-small-latest', weight: 5, out: 300, labels: ['topic_soporte'] },
  { key: 'resumen-diario', provider: 'anthropic', model: 'claude-haiku-4-5-20251001', weight: 2, out: 800, labels: ['feature_resumen'] },
  { key: 'lucas', provider: 'ollama', model: 'llama3.2', weight: 2, out: 300, labels: ['topic_soporte'] },
]

function history() {
  const r = rng(20261028)
  const who = Object.fromEntries([
    ...PEOPLE.map(p => [p.email.split('@')[0], { key_id: p.id, team_id: p.team }]),
    ...AGENTS.map(a => [a.name, { key_id: `agent:${a.id}`, team_id: a.team }]),
  ])
  const total = MIX.reduce((a, m) => a + m.weight, 0)
  const pick = () => {
    let x = r() * total
    for (const m of MIX) if ((x -= m.weight) < 0) return m
    return MIX.at(-1)
  }
  const out = []
  const today = new Date()
  today.setUTCHours(0, 0, 0, 0)
  for (let d = 28; d >= 1; d--) {
    const weekend = [0, 6].includes(new Date(today.getTime() - d * 864e5).getUTCDay())
    const n = Math.round((weekend ? 25 : 110) * (0.8 + r() * 0.4))
    for (let i = 0; i < n; i++) {
      const m = pick()
      const ts = new Date(today.getTime() - d * 864e5 + (8 + r() * 11) * 3600e3)
      const tokensOut = Math.round(m.out * (0.4 + r() * 1.2))
      const tokensIn = Math.round(tokensOut * (1.5 + r() * 4))
      const ms = Math.round(250 + tokensOut * (3 + r() * 5))
      let status = 200, reason = 'ok'
      const roll = r()
      if (roll < 0.015) { status = 502; reason = 'upstream_unreachable' }
      else if (roll < 0.03 && m.key === 'marketing') { status = 403; reason = 'model_not_allowed' }
      else if (roll < 0.04) { status = 429; reason = 'upstream_rate_limited' }
      const ok = status === 200
      out.push({
        id: uuid(r), ts: ts.toISOString(), request_id: `req_demo_${out.length}`, ...who[m.key],
        provider: reason === 'model_not_allowed' ? '' : m.provider, model: m.model, status, reason,
        stream: r() < 0.6, duration_ms: ok ? ms : 40, upstream_ms: ok ? ms - 15 : 0,
        tokens_in: ok ? tokensIn : 0, tokens_out: ok ? tokensOut : 0, labels: m.labels,
      })
    }
  }
  return out
}

async function report(records) {
  const url = `${process.env.STRATUM_CP_URL ?? 'http://control-plane:3000'}/api/internal/usage`
  for (let i = 0; i < records.length; i += 500) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${GATEWAY.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ instance_id: GATEWAY.id, records: records.slice(i, i + 500) }),
    })
    if (!res.ok) throw new Error(`usage report: ${res.status} ${await res.text()}`)
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL })
  await db.connect()
  try {
    await setup(db)
    const { rows } = await db.query(`SELECT count(*)::int AS n FROM request_logs
                                      WHERE org_id = $1 AND created_at < date_trunc('day', now())`, [ORG])
    if (rows[0].n === 0) {
      const records = history()
      await report(records)
      console.log(`history: ${records.length} requests over the last 28 days`)
    }
  } finally {
    await db.end()
  }
  console.log(`
  Stratum demo is ready: http://localhost:3000

    owner@acme.com     stratum-demo-owner     (sets up a second factor at the first sign-in)
    auditor@acme.com   stratum-demo-auditor   (reads everything, changes nothing)

  Gateway: http://localhost:20128, with a developer key:
    curl http://localhost:20128/v1/chat/completions \\
      -H "Authorization: Bearer ${PEOPLE[0].key}" \\
      -H "content-type: application/json" \\
      -d '{"model":"openai/gpt-4o-mini","messages":[{"role":"user","content":"Hola"}]}'

  Every answer comes from a mock LLM: no provider is called, nothing is paid.
  DEMO ONLY: fixed passwords and keys. Do not expose these ports.
`)
}
