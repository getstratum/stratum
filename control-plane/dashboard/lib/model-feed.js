/**
 * lib/model-feed.js — the model catalog feed (ADR-0012).
 *
 * The model catalog (ai_models: IDs, aliases, list prices) changes more often
 * than Stratum is released. The control plane reads a feed — by default
 * catalog/models.json in the Stratum repository — once a day and applies it:
 *
 *   - a model is added or updated (name, aliases, prices, retirement date);
 *   - a model missing from the feed is left as it is: a feed never deletes,
 *     so a truncated or wrong feed cannot empty the catalog;
 *   - "retired": true stops offering a model (is_active = false).
 *
 * New or changed IDs give the policies that name the model a new version
 * (triggers of migrations 023 and 024); a price change does not.
 *
 * STRATUM_MODEL_CATALOG_URL sets the feed (https, or "off"); `stratum-admin
 * catalog-update --file` applies a local copy, for installations without
 * internet access.
 */

export const DEFAULT_FEED_URL = 'https://raw.githubusercontent.com/getstratum/stratum/main/catalog/models.json'
export const MAX_FEED_BYTES = 2 * 1024 * 1024
const MAX_MODELS = 5000
const MAX_PRICE_PER_MTOK = 100000 // US$ per million tokens; the column holds up to 9,999.999999 per 1K

const PROVIDER_RE = /^[a-z0-9][a-z0-9-]{0,49}$/
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:@/+-]{0,99}$/
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

export class FeedError extends Error {}

function price(v, where) {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > MAX_PRICE_PER_MTOK) {
    throw new FeedError(`${where}: price must be a number from 0 to ${MAX_PRICE_PER_MTOK} (US$ per million tokens)`)
  }
  return Math.round(v * 1e6) / 1e6
}

/**
 * Validates a feed (already parsed JSON) and returns its models, normalized.
 * Throws FeedError naming the first problem: one bad entry rejects the feed,
 * rather than applying part of it.
 */
export function parseFeed(feed) {
  if (!feed || typeof feed !== 'object' || Array.isArray(feed)) throw new FeedError('the feed is not a JSON object')
  if (feed.schema !== 1) throw new FeedError(`unsupported schema ${JSON.stringify(feed.schema)} (expected 1)`)
  if (typeof feed.updated !== 'string' || !DATE_RE.test(feed.updated)) throw new FeedError('"updated" must be a YYYY-MM-DD date')
  if (!Array.isArray(feed.models) || feed.models.length === 0 || feed.models.length > MAX_MODELS) {
    throw new FeedError(`"models" must list 1 to ${MAX_MODELS} models`)
  }
  const seen = new Map() // provider → Set of IDs and aliases
  const models = feed.models.map((m, i) => {
    const where = `models[${i}]`
    if (!m || typeof m !== 'object') throw new FeedError(`${where}: not an object`)
    if (typeof m.provider !== 'string' || !PROVIDER_RE.test(m.provider)) throw new FeedError(`${where}: invalid provider`)
    if (typeof m.id !== 'string' || !MODEL_RE.test(m.id)) throw new FeedError(`${where}: invalid id`)
    const at = `${where} (${m.provider}/${m.id})`
    if (typeof m.name !== 'string' || !m.name.trim() || m.name.length > 255) throw new FeedError(`${at}: invalid name`)
    const aliases = m.aliases ?? []
    if (!Array.isArray(aliases) || aliases.length > 20 || aliases.some(a => typeof a !== 'string' || !MODEL_RE.test(a) || a === m.id)) {
      throw new FeedError(`${at}: invalid aliases`)
    }
    const names = seen.get(m.provider) ?? new Set()
    for (const n of [m.id, ...aliases]) {
      if (names.has(n)) throw new FeedError(`${at}: "${n}" is already the ID or an alias of another ${m.provider} model`)
      names.add(n)
    }
    seen.set(m.provider, names)
    const deprecated = m.deprecated_on ?? null
    if (deprecated !== null && (typeof deprecated !== 'string' || !DATE_RE.test(deprecated))) {
      throw new FeedError(`${at}: deprecated_on must be a YYYY-MM-DD date or null`)
    }
    if (m.retired !== undefined && typeof m.retired !== 'boolean') throw new FeedError(`${at}: retired must be true or false`)
    return {
      provider: m.provider,
      id: m.id,
      name: m.name.trim(),
      aliases: [...new Set(aliases)].sort(),
      input: price(m.input_per_mtok, at),
      output: price(m.output_per_mtok, at),
      deprecatedOn: deprecated,
      active: m.retired !== true,
    }
  })
  return { updated: feed.updated, models }
}

/**
 * Applies a parsed feed in one transaction. Only rows whose values change
 * are written. Another control plane replica applying at the same time makes
 * this one skip (same feed, same result).
 *
 * @returns {{ applied: boolean, models: number, changed: number }}
 */
export async function applyFeed(db, parsed, { source }) {
  // A pool lends one client for the transaction; a client is used as it is.
  const isPool = typeof db.connect === 'function' && 'totalCount' in db
  const client = isPool ? await db.connect() : db
  const release = isPool ? () => client.release() : () => {}
  try {
    await client.query('BEGIN')
    const { rows: [lock] } = await client.query('SELECT pg_try_advisory_xact_lock(4723024) AS ok')
    if (!lock.ok) {
      await client.query('ROLLBACK')
      return { applied: false, models: parsed.models.length, changed: 0 }
    }
    const col = k => parsed.models.map(m => m[k])
    const { rowCount } = await client.query(`
      INSERT INTO ai_models AS a (provider, model_id, display_name, aliases,
                                  cost_per_1k_input_tokens, cost_per_1k_output_tokens,
                                  deprecated_on, is_active, source, updated_at)
      SELECT f.provider, f.id, f.name, ARRAY(SELECT jsonb_array_elements_text(f.aliases)),
             f.input / 1000.0, f.output / 1000.0, f.deprecated_on::date, f.active, 'feed', now()
        FROM unnest($1::text[], $2::text[], $3::text[], $4::jsonb[], $5::numeric[], $6::numeric[], $7::text[], $8::boolean[])
             AS f(provider, id, name, aliases, input, output, deprecated_on, active)
      ON CONFLICT (provider, model_id) DO UPDATE
         SET display_name = EXCLUDED.display_name, aliases = EXCLUDED.aliases,
             cost_per_1k_input_tokens = EXCLUDED.cost_per_1k_input_tokens,
             cost_per_1k_output_tokens = EXCLUDED.cost_per_1k_output_tokens,
             deprecated_on = EXCLUDED.deprecated_on, is_active = EXCLUDED.is_active,
             source = 'feed', updated_at = now()
       WHERE (a.display_name, a.aliases, a.cost_per_1k_input_tokens, a.cost_per_1k_output_tokens,
              a.deprecated_on, a.is_active)
             IS DISTINCT FROM
             (EXCLUDED.display_name, EXCLUDED.aliases, EXCLUDED.cost_per_1k_input_tokens,
              EXCLUDED.cost_per_1k_output_tokens, EXCLUDED.deprecated_on, EXCLUDED.is_active)`,
      [col('provider'), col('id'), col('name'), parsed.models.map(m => JSON.stringify(m.aliases)),
       col('input'), col('output'), col('deprecatedOn'), col('active')])
    await client.query(`
      UPDATE model_catalog_state
         SET source = $1, feed_updated = $2, models = $3, changed = $4,
             checked_at = now(), applied_at = now(), error = NULL`,
      [source, parsed.updated, parsed.models.length, rowCount])
    await client.query('COMMIT')
    return { applied: true, models: parsed.models.length, changed: rowCount }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    release()
  }
}

async function recordError(db, source, message) {
  await db.query(
    'UPDATE model_catalog_state SET source = $1, checked_at = now(), error = $2',
    [source, String(message).slice(0, 500)]).catch(() => {})
}

/** The feed URL from STRATUM_MODEL_CATALOG_URL, or null when turned off. */
export function feedUrl(env = process.env) {
  const v = (env.STRATUM_MODEL_CATALOG_URL ?? '').trim()
  if (v.toLowerCase() === 'off') return null
  return v || DEFAULT_FEED_URL
}

/**
 * Fetches the feed and applies it. Never throws: the result says what
 * happened, and a failure is also recorded in model_catalog_state (the
 * console shows it). The catalog stays as it was.
 */
export async function refreshCatalog(db, { url = feedUrl(), fetchImpl = fetch, timeoutMs = 15000 } = {}) {
  if (!url) return { ok: false, skipped: true, message: 'STRATUM_MODEL_CATALOG_URL=off' }
  let u
  try {
    u = new URL(url)
  } catch {
    u = null
  }
  if (!u || u.protocol !== 'https:') {
    await recordError(db, url, 'the feed URL must be https')
    return { ok: false, message: 'the feed URL must be https' }
  }
  try {
    const res = await fetchImpl(u, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: 'application/json' } })
    if (!res.ok) throw new FeedError(`the feed answered ${res.status}`)
    const declared = Number(res.headers.get('content-length'))
    if (declared > MAX_FEED_BYTES) throw new FeedError('the feed is larger than 2 MB')
    const text = await res.text()
    if (Buffer.byteLength(text) > MAX_FEED_BYTES) throw new FeedError('the feed is larger than 2 MB')
    let json
    try {
      json = JSON.parse(text)
    } catch {
      throw new FeedError('the feed is not valid JSON')
    }
    const result = await applyFeed(db, parseFeed(json), { source: url })
    return { ok: true, ...result }
  } catch (err) {
    const message = err instanceof FeedError ? err.message
      : err?.name === 'TimeoutError' ? 'the feed did not answer in time' : `could not read the feed: ${err?.message ?? err}`
    await recordError(db, url, message)
    return { ok: false, message }
  }
}
