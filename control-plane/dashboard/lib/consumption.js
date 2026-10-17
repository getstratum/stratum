/**
 * lib/consumption.js — consumption grouped by one dimension (team, agent,
 * person, model or provider), from request_logs, for the Consumo page.
 *
 * Totals and per-group rows carry requests, errors, requests refused by a
 * policy, tokens, estimated cost and latency percentiles; the daily series
 * (UTC days) carries requests, tokens and cost per group. Everything is
 * limited to what the session may read (lib/usage.js logsScope).
 */

import { badRequest, isUuid } from './route.js'
import { logsScope } from './usage.js'

export const DIMENSIONS = ['team', 'agent', 'user', 'model', 'provider']

// Reasons a gateway refuses a request because of the team's policy or quota,
// not because something failed.
export const POLICY_REASONS = [
  'no_policy', 'team_disabled', 'provider_not_allowed', 'model_not_allowed',
  'quota_exceeded', 'sensitive_data_detected', 'agent_model_mismatch',
]

const KEY = {
  team:     `r.team_id::text`,
  agent:    `r.agent_id::text`,
  user:     `r.user_id::text`,
  // Refused before a provider was chosen: no provider (NULL, "Sin asignar").
  model:    `NULLIF(r.provider, '') || '/' || r.model_id`,
  provider: `NULLIF(r.provider, '')`,
}

// Rows that belong to the dimension at all: agent and person traffic are
// apart, so "por agente" never mixes in people.
const PRESENT = {
  team: 'TRUE', agent: 'r.agent_id IS NOT NULL', user: 'r.user_id IS NOT NULL', model: 'TRUE', provider: 'TRUE',
}

/**
 * Validated ?by and the optional drill-down filter (one of ?team ?agent
 * ?user ?model ?provider).
 */
export function parseQuery(searchParams) {
  const by = searchParams.get('by') ?? 'team'
  if (!DIMENSIONS.includes(by)) throw badRequest(`by tiene que ser uno de: ${DIMENSIONS.join(', ')}.`)
  let filter = null
  for (const kind of DIMENSIONS) {
    const v = searchParams.get(kind)
    if (v == null || v === '') continue
    if (filter) throw badRequest('Filtrá por una sola cosa a la vez.')
    if (['team', 'agent', 'user'].includes(kind) && !isUuid(v)) throw badRequest(`${kind} inválido.`)
    if (v.length > 200) throw badRequest(`${kind} inválido.`)
    filter = { kind, value: v }
  }
  return { by, filter }
}

const num = v => (v == null ? 0 : Number(v))

function where(session, { from, to, by, filter }, params) {
  params.push(from, to)
  const parts = [`r.created_at >= $${params.length - 1}`, `r.created_at <= $${params.length}`,
    logsScope(session, 'r', params), PRESENT[by]]
  if (filter) {
    params.push(filter.value)
    parts.push(`${KEY[filter.kind]} = $${params.length}`)
  }
  return parts.join(' AND ')
}

const AGGREGATES = `
  COUNT(*)                                                     AS requests,
  COUNT(*) FILTER (WHERE r.status_code >= 400)                 AS errors,
  COUNT(*) FILTER (WHERE r.error_message = ANY($POLICY))       AS blocked,
  COALESCE(SUM(r.tokens_input), 0)                             AS tokens_in,
  COALESCE(SUM(r.tokens_output), 0)                            AS tokens_out,
  COALESCE(SUM(r.cost_usd), 0)                                 AS cost,
  -- Latency of requests that reached a provider: refusals take a few
  -- milliseconds and would make it look better than it is.
  percentile_cont(0.5)  WITHIN GROUP (ORDER BY r.latency_ms) FILTER (WHERE r.provider_ms > 0) AS p50_ms,
  percentile_cont(0.95) WITHIN GROUP (ORDER BY r.latency_ms) FILTER (WHERE r.provider_ms > 0) AS p95_ms,
  MAX(r.created_at)                                            AS last_at`

function aggregates(params) {
  params.push(POLICY_REASONS)
  return AGGREGATES.replace('$POLICY', `$${params.length}`)
}

const shape = r => ({
  requests: num(r.requests), errors: num(r.errors), blocked: num(r.blocked),
  tokens_in: num(r.tokens_in), tokens_out: num(r.tokens_out), cost: num(r.cost),
  p50_ms: r.p50_ms == null ? null : Math.round(num(r.p50_ms)),
  p95_ms: r.p95_ms == null ? null : Math.round(num(r.p95_ms)),
  last_at: r.last_at ?? null,
})

/**
 * Names for team, agent and person keys: from this organization, and for a
 * team manager from their team only (a name is not shown to whom may not
 * read it, even when the id was guessed).
 */
async function labels(db, session, kind, keys) {
  if (!keys.length) return new Map()
  const table = { team: 'teams', agent: 'agents', user: 'users' }[kind]
  if (!table) return new Map(keys.map(k => [k, k]))
  const name = kind === 'user' ? `COALESCE(NULLIF(name, ''), email)` : 'name'
  const params = [session.orgId, keys]
  let scope = ''
  if (session.scope === 'team') {
    params.push(session.teamId)
    scope = kind === 'team' ? ' AND id = $3' : ' AND team_id = $3'
  }
  const { rows } = await db.query(
    `SELECT id::text AS id, ${name} AS label FROM ${table} WHERE org_id = $1 AND id::text = ANY($2)${scope}`, params)
  return new Map(rows.map(r => [r.id, r.label]))
}

export async function consumption(db, session, { from, to, by, filter }) {
  const q = { from, to, by, filter }

  const pt = []
  const wt = where(session, q, pt)
  const at = aggregates(pt)
  const pr = []
  const wr = where(session, q, pr)
  const ar = aggregates(pr)
  const pd = []
  const wd = where(session, q, pd)

  const [totals, rows, days] = await Promise.all([
    db.query(`SELECT ${at} FROM request_logs r WHERE ${wt}`, pt),
    db.query(`
      SELECT ${KEY[by]} AS key, ${ar}
        FROM request_logs r
       WHERE ${wr}
       GROUP BY 1
       ORDER BY cost DESC, requests DESC
       LIMIT 200`, pr),
    db.query(`
      SELECT to_char(date_trunc('day', r.created_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day,
             ${KEY[by]} AS key,
             COUNT(*)                                     AS requests,
             COALESCE(SUM(r.tokens_input + r.tokens_output), 0) AS tokens,
             COALESCE(SUM(r.cost_usd), 0)                 AS cost
        FROM request_logs r
       WHERE ${wd}
       GROUP BY 1, 2
       ORDER BY 1`, pd),
  ])

  const keys = rows.rows.map(r => r.key).filter(Boolean)
  const names = await labels(db, session, by, keys)
  let filterLabel = null
  if (filter) {
    const m = await labels(db, session, filter.kind, [filter.value])
    filterLabel = m.get(filter.value) ?? null
  }

  return {
    by,
    from: from.toISOString(),
    to: to.toISOString(),
    filter: filter ? { ...filter, label: filterLabel } : null,
    totals: shape(totals.rows[0] ?? {}),
    rows: rows.rows.map(r => ({
      key: r.key,
      label: r.key == null ? 'Sin asignar' : names.get(r.key) ?? (['team', 'agent', 'user'].includes(by) ? 'Eliminado' : r.key),
      ...shape(r),
    })),
    days: days.rows.map(d => ({ day: d.day, key: d.key, requests: num(d.requests), tokens: num(d.tokens), cost: num(d.cost) })),
  }
}
