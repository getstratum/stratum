/**
 * Dynamic provider loader.
 *
 * Instead of hardcoding OpenAI/Anthropic in proxy.js, providers are stored
 * in the DB table `providers`. This makes it a pure data operation to
 * add, disable, or modify a provider — no code changes needed.
 *
 * Cache: providers are loaded once on startup and on SIGHUP.
 * To force a reload from the dashboard, POST /admin/reload-providers.
 */

let _cache = null
let _loadedAt = 0
const CACHE_TTL_MS = 60_000  // re-check DB every 60s

export async function getProviders(db) {
  const now = Date.now()
  if (_cache && now - _loadedAt < CACHE_TTL_MS) return _cache

  const { rows } = await db.query(`
    SELECT slug, display_name, base_url, api_type, api_key_env, auth_header
    FROM providers
    WHERE is_active = true
    ORDER BY created_at
  `)

  _cache    = buildProviderMap(rows)
  _loadedAt = now
  return _cache
}

export function invalidateCache() {
  _cache = null
}

// ─── Build provider config from DB row ───────────────────────────────────────

function buildProviderMap(rows) {
  const map = {}
  for (const row of rows) {
    const cfg = buildConfig(row)
    if (cfg) map[row.slug] = cfg
  }
  return map
}

function buildConfig(row) {
  const apiKey = process.env[row.api_key_env]

  // Log missing key but don't crash — provider will fail at request time
  if (!apiKey && row.slug !== 'ollama') {
    console.warn(`[providers] ${row.slug}: env var "${row.api_key_env}" is not set`)
  }

  switch (row.api_type) {

    case 'openai-compatible':
      return {
        baseUrl: row.base_url,
        buildHeaders: () => ({
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${apiKey ?? 'not-configured'}`,
        }),
        extractModel:     body => body.model,
        extractUsage:     body => ({
          input:  body.usage?.prompt_tokens     ?? 0,
          output: body.usage?.completion_tokens ?? 0,
        }),
        enrichStreamBody: body => ({
          ...body,
          stream_options: { include_usage: true },
        }),
      }

    case 'anthropic':
      return {
        baseUrl: row.base_url,
        buildHeaders: () => ({
          'Content-Type':      'application/json',
          'x-api-key':         apiKey ?? 'not-configured',
          'anthropic-version': '2023-06-01',
        }),
        extractModel:     body => body.model,
        extractUsage:     body => ({
          input:  body.usage?.input_tokens  ?? 0,
          output: body.usage?.output_tokens ?? 0,
        }),
        enrichStreamBody: body => body,
      }

    case 'aws-bedrock':
      // Placeholder — full AWS Sig V4 implementation in a future version
      console.warn('[providers] aws-bedrock: not yet implemented')
      return null

    default:
      console.warn(`[providers] unknown api_type "${row.api_type}" for ${row.slug}`)
      return null
  }
}
