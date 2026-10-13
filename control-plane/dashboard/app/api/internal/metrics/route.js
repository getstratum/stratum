/**
 * POST /api/internal/metrics
 *
 * Recepción de métricas agregadas desde el data plane de stratum.
 * Autenticado con el mismo Bearer sync token que /api/internal/sync.
 *
 * Body (MetricsPush):
 *   {
 *     instance_id: string,
 *     window: { start: string, end: string },
 *     requests: Array<{
 *       team_id: string,
 *       model: string,
 *       provider?: string,
 *       req_count: number,
 *       prompt_tokens: number,
 *       completion_tokens: number,
 *       cost_usd: number,
 *       error_count: number
 *     }>
 *   }
 *
 * NUNCA se almacena contenido de prompts ni respuestas.
 * Solo metadata agregada por ventana de tiempo y dimensiones de routing.
 */

import { NextResponse } from 'next/server'
import { createHash }   from 'crypto'
import { query }        from '@/lib/db'

export const dynamic = 'force-dynamic'

// ---------------------------------------------------------------------------
// Auth helpers
// ---------------------------------------------------------------------------

function hashSyncToken(rawToken) {
  return createHash('sha256').update(rawToken).digest('hex')
}

async function authenticateInstance(authHeader) {
  if (!authHeader?.startsWith('Bearer ')) return null
  const rawToken = authHeader.slice(7)
  if (!rawToken) return null

  const tokenHash = hashSyncToken(rawToken)
  const rows = await query(
    `SELECT id, org_id, disabled
     FROM data_plane_instances
     WHERE sync_token_hash = $1 AND disabled = false
     LIMIT 1`,
    [tokenHash]
  )
  return rows[0] ?? null
}

// ---------------------------------------------------------------------------
// Validación del body
// ---------------------------------------------------------------------------

function validateMetricsBody(body) {
  if (!body || typeof body !== 'object') return 'body must be an object'
  if (typeof body.instance_id !== 'string') return 'instance_id must be a string'

  const w = body.window
  if (!w || typeof w !== 'object') return 'window must be an object'
  if (typeof w.start !== 'string' || typeof w.end !== 'string') {
    return 'window.start and window.end must be ISO strings'
  }

  if (!Array.isArray(body.requests)) return 'requests must be an array'
  if (body.requests.length === 0) return null // empty batch is fine

  for (let i = 0; i < body.requests.length; i++) {
    const r = body.requests[i]
    if (typeof r.team_id !== 'string')          return `requests[${i}].team_id must be a string`
    if (typeof r.model   !== 'string')          return `requests[${i}].model must be a string`
    if (typeof r.prompt_tokens     !== 'number') return `requests[${i}].prompt_tokens must be a number`
    if (typeof r.completion_tokens !== 'number') return `requests[${i}].completion_tokens must be a number`
    if (typeof r.cost_usd          !== 'number') return `requests[${i}].cost_usd must be a number`
  }

  return null // valid
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function POST(request) {
  // 1. Auth
  const authHeader = request.headers.get('authorization')
  const instance = await authenticateInstance(authHeader)

  if (!instance) {
    return NextResponse.json(
      { error: { type: 'authentication_error', message: 'Invalid or missing sync token.' } },
      { status: 401 }
    )
  }

  // 2. Parse + validate body
  let body
  try {
    body = await request.json()
  } catch {
    return NextResponse.json(
      { error: { type: 'parse_error', message: 'Invalid JSON body.' } },
      { status: 400 }
    )
  }

  const validationError = validateMetricsBody(body)
  if (validationError) {
    return NextResponse.json(
      { error: { type: 'validation_error', message: validationError } },
      { status: 400 }
    )
  }

  // 3. instance_id match
  if (body.instance_id !== instance.id) {
    return NextResponse.json(
      { error: { type: 'permission_error', message: 'instance_id does not match token.' } },
      { status: 403 }
    )
  }

  // 4. Empty batch
  if (body.requests.length === 0) {
    return NextResponse.json({ accepted: 0 })
  }

  // 5. Bulk insert via unnest (pg parameterized — compatible with @/lib/db query())
  const windowStart = new Date(body.window.start)
  const windowEnd   = new Date(body.window.end)

  const rows = body.requests.map(r => ({
    instance_id:       instance.id,
    window_start:      windowStart,
    window_end:        windowEnd,
    team_id:           r.team_id,
    model:             r.model,
    provider:          r.provider ?? null,
    req_count:         r.req_count         ?? 1,
    prompt_tokens:     r.prompt_tokens,
    completion_tokens: r.completion_tokens,
    cost_usd:          r.cost_usd,
    error_count:       r.error_count       ?? 0,
  }))

  try {
    await query(
      `INSERT INTO stratum_metrics (
        instance_id, window_start, window_end,
        team_id, model, provider,
        req_count, prompt_tokens, completion_tokens, cost_usd, error_count
      )
      SELECT * FROM unnest(
        $1::text[], $2::timestamptz[], $3::timestamptz[],
        $4::text[], $5::text[], $6::text[],
        $7::int[], $8::bigint[], $9::bigint[], $10::decimal[], $11::int[]
      )`,
      [
        rows.map(r => r.instance_id),
        rows.map(r => r.window_start),
        rows.map(r => r.window_end),
        rows.map(r => r.team_id),
        rows.map(r => r.model),
        rows.map(r => r.provider),
        rows.map(r => r.req_count),
        rows.map(r => r.prompt_tokens),
        rows.map(r => r.completion_tokens),
        rows.map(r => r.cost_usd),
        rows.map(r => r.error_count),
      ]
    )

    // Heartbeat async
    query(
      `UPDATE data_plane_instances SET last_seen_at = now() WHERE id = $1`,
      [instance.id]
    ).catch(err => console.error('[metrics] failed to update instance heartbeat:', err))

    return NextResponse.json({ accepted: rows.length })
  } catch (err) {
    console.error('[metrics] insert error:', err)
    return NextResponse.json(
      { error: { type: 'server_error', message: 'Failed to persist metrics.' } },
      { status: 500 }
    )
  }
}
