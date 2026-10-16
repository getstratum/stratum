/**
 * Ingest of the per-request usage gateways report (ADR-0009, api/usage/v1).
 *
 * A batch is stored in one statement. Ownership is never taken from the
 * gateway: the organization is the reporting instance's, and a team, user
 * or agent ID that is not in that organization is stored as NULL. The cost
 * is computed here from the model catalog (ai_models), not sent by gateways.
 * Records already stored (same ID and time: a retried batch) are skipped.
 */

export const MAX_RECORDS = 500
export const MAX_BODY_BYTES = 2 * 1024 * 1024

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const REASON_RE = /^[a-z0-9_]{1,64}$/
const FLAG_RE = /^[a-z0-9_]{1,40}$/
const INT32 = 2_147_483_647
const MAX_AGE_MS = 35 * 24 * 3600 * 1000 // older than the console's views
const MAX_SKEW_MS = 5 * 60 * 1000         // gateway clock ahead of ours

const isInt = (v, min, max) => Number.isInteger(v) && v >= min && v <= max
const clampInt = (v) => Math.min(v, INT32)

/**
 * Checks one record. Returns the normalized record, or null when it cannot
 * be stored (the rest of the batch still is).
 */
export function normalizeRecord(r, now = Date.now()) {
  if (!r || typeof r !== 'object' || Array.isArray(r)) return null
  if (typeof r.id !== 'string' || !UUID_RE.test(r.id)) return null
  const ts = typeof r.ts === 'string' ? Date.parse(r.ts) : NaN
  if (!Number.isFinite(ts) || ts < now - MAX_AGE_MS || ts > now + MAX_SKEW_MS) return null
  if (typeof r.key_id !== 'string' || !r.key_id || r.key_id.length > 200) return null
  if (!isInt(r.status, 100, 599)) return null
  if (typeof r.stream !== 'boolean') return null
  for (const k of ['duration_ms', 'upstream_ms', 'tokens_in', 'tokens_out']) {
    if (!isInt(r[k], 0, Number.MAX_SAFE_INTEGER)) return null
  }
  const reason = r.reason == null || r.reason === '' ? 'ok' : r.reason
  if (typeof reason !== 'string' || !REASON_RE.test(reason)) return null
  const flags = r.content_flags ?? []
  if (!Array.isArray(flags) || flags.length > 20 || !flags.every(f => typeof f === 'string' && FLAG_RE.test(f))) return null
  const text = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '')

  return {
    id: r.id.toLowerCase(),
    ts: new Date(ts).toISOString(),
    request_id: text(r.request_id, 128) || null,
    key_id: r.key_id,
    team_id: typeof r.team_id === 'string' && UUID_RE.test(r.team_id) ? r.team_id.toLowerCase() : null,
    provider: text(r.provider, 50),
    model: text(r.model, 100),
    status: r.status,
    reason,
    stream: r.stream,
    duration_ms: clampInt(r.duration_ms),
    upstream_ms: clampInt(r.upstream_ms),
    tokens_in: clampInt(r.tokens_in),
    tokens_out: clampInt(r.tokens_out),
    flags: [...new Set(flags)].join(','),
  }
}

const col = (records, k) => records.map(r => r[k])

/**
 * Stores normalized records for an instance. Returns how many were new.
 * `db` is a pool or client.
 */
export async function ingest(db, instance, records) {
  if (!records.length) return 0
  const { rowCount } = await db.query(
    `WITH r AS (
       SELECT * FROM unnest(
         $3::uuid[], $4::timestamptz[], $5::text[], $6::text[], $7::text[], $8::text[], $9::text[],
         $10::int[], $11::text[], $12::bool[], $13::int[], $14::int[], $15::int[], $16::int[], $17::text[]
       ) AS t(id, ts, request_id, key_id, team_id, provider, model,
              status, reason, stream, duration_ms, upstream_ms, tokens_in, tokens_out, flags)
     )
     INSERT INTO request_logs (
       id, created_at, org_id, team_id, user_id, agent_id, provider, model_id,
       tokens_input, tokens_output, cost_usd, status_code, latency_ms, provider_ms,
       is_stream, error_message, pii_flagged, pii_types, instance_id, request_id)
     SELECT r.id, r.ts, $1::uuid, tm.id, u.id, a.id, r.provider, r.model,
            r.tokens_in, r.tokens_out,
            -- request_logs.cost_usd is DECIMAL(10,6): a cost past it would
            -- fail the whole batch, and the gateway would resend it forever.
            LEAST(COALESCE(round((r.tokens_in * m.cost_per_1k_input_tokens
                                + r.tokens_out * m.cost_per_1k_output_tokens) / 1000.0, 6), 0),
                  9999.999999),
            r.status, r.duration_ms, r.upstream_ms,
            r.stream, NULLIF(r.reason, 'ok'), r.flags <> '',
            COALESCE(string_to_array(NULLIF(r.flags, ''), ','), '{}'), $2, r.request_id
       FROM r
       LEFT JOIN teams tm  ON tm.id::text = r.team_id AND tm.org_id = $1::uuid
       LEFT JOIN users u   ON r.key_id NOT LIKE 'agent:%' AND u.id::text = r.key_id AND u.org_id = $1::uuid
       LEFT JOIN agents a  ON r.key_id LIKE 'agent:%' AND a.id::text = substr(r.key_id, 7) AND a.org_id = $1::uuid
       LEFT JOIN ai_models m ON m.provider = r.provider AND m.model_id = r.model
     ON CONFLICT DO NOTHING`,
    [instance.org_id, instance.id,
     col(records, 'id'), col(records, 'ts'), col(records, 'request_id'), col(records, 'key_id'),
     col(records, 'team_id'), col(records, 'provider'), col(records, 'model'), col(records, 'status'),
     col(records, 'reason'), col(records, 'stream'), col(records, 'duration_ms'), col(records, 'upstream_ms'),
     col(records, 'tokens_in'), col(records, 'tokens_out'), col(records, 'flags')])
  await db.query('UPDATE data_plane_instances SET last_usage_at = now() WHERE id = $1', [instance.id])
  return rowCount
}
