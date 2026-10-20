// The models an organization can use, sent to gateways with every sync for
// GET /v1/models (lib/sync.js).
//
//   DATABASE_URL=postgres://... node --import ./test/register.mjs --test test/
//
// Skipped without DATABASE_URL.

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { buildSyncResponse } from '../lib/sync.js'

const url = process.env.DATABASE_URL
const skip = url ? false : 'DATABASE_URL not set'
let pool
const orgs = []
const sql = async (text, params = []) => (await pool.query(text, params)).rows

before(async () => {
  if (!url) return
  pool = new pg.Pool({ connectionString: url, max: 2 })
  await sql(`INSERT INTO ai_models (provider, model_id, display_name, cost_per_1k_input_tokens, cost_per_1k_output_tokens, deprecated_on)
             VALUES ('openai', 'list-test-current', 'List test', 0.001, 0.002, NULL),
                    ('openai', 'list-test-retired', 'Retired', 0.001, 0.002, DATE '2020-01-01'),
                    ('openai', 'list-test-off', 'Turned off', 0.001, 0.002, NULL),
                    ('mistral', 'list-test-mistral', 'Not configured', 0.001, 0.002, NULL)
             ON CONFLICT (provider, model_id) DO NOTHING`)
})

after(async () => {
  if (!pool) return
  await sql('DELETE FROM organizations WHERE id = ANY($1::uuid[])', [orgs])
  await sql(`DELETE FROM ai_models WHERE model_id LIKE 'list-test-%'`)
  await pool.end()
})

async function sync(orgId, since = 0) {
  const client = await pool.connect()
  try {
    return JSON.parse(JSON.stringify(await buildSyncResponse(client, {
      orgId, sinceVersion: since, syncIntervalS: 30, decrypt: v => v, warn: () => {},
    })))
  } finally {
    client.release()
  }
}

test('models: what the organization can use, with every sync', { skip }, async () => {
  const org = randomUUID()
  orgs.push(org)
  await sql(`INSERT INTO organizations (id, name) VALUES ($1, 'models')`, [org])
  await sql(`INSERT INTO provider_configs (id, org_id, provider, display_name, api_key_encrypted, enabled)
             VALUES ($2, $1, 'openai', 'OpenAI', 'iv:ct', true)`, [org, `pc_${randomUUID()}`])
  await sql(`INSERT INTO org_model_settings (org_id, provider, model_id, enabled) VALUES ($1, 'openai', 'list-test-off', false)`, [org])
  await sql(`INSERT INTO provider_models (org_id, provider, model_id) VALUES ($1, 'openai', 'ft:list-test-custom')`, [org])

  const full = await sync(org)
  const ids = full.models.map(m => `${m.provider}/${m.id}`)
  assert.ok(ids.includes('openai/list-test-current'))
  assert.ok(ids.includes('openai/ft:list-test-custom'), 'a model the provider listed')
  assert.ok(!ids.includes('openai/list-test-off'), 'turned off for the organization')
  assert.ok(!ids.includes('openai/list-test-retired'), 'past its deprecation date')
  assert.ok(!ids.some(i => i.startsWith('mistral/')), 'a provider the organization did not configure')
  assert.deepEqual(full.models.find(m => m.id === 'list-test-current'), { provider: 'openai', id: 'list-test-current', name: 'List test' })
  assert.deepEqual(full.models.find(m => m.id === 'ft:list-test-custom'), { provider: 'openai', id: 'ft:list-test-custom' })
  assert.deepEqual(ids, [...ids].sort(), 'sorted by provider and id')

  // Deltas carry it too: turning a model on reaches gateways at once.
  await sql(`UPDATE org_model_settings SET enabled = true WHERE org_id = $1 AND model_id = 'list-test-off'`, [org])
  const delta = await sync(org, full.current_version)
  assert.ok(delta.models.some(m => m.id === 'list-test-off'))
})
