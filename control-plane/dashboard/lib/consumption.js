/**
 * lib/consumption.js — consumption grouped by one dimension (team, agent,
 * application, person, model, provider or label), from request_logs, for
 * the Consumo page.
 *
 * Agents and applications are both agents' keys, apart by how a request
 * used it: an agent's request is its own work (no person); an
 * application's is on behalf of a person (a key that delegates, with
 * X-Stratum-User: a chat portal, say). Kept apart, people chatting through
 * an application never pass for an agent's cost, and "Aplicaciones" says
 * how many people used each one.
 *
 * Labels are the application's (X-Stratum-Labels, migration 029): a request
 * with two labels counts in both rows, so per-label rows can add up to more
 * than the totals, which cover requests with any label.
 *
 * Totals and per-group rows carry requests, errors, requests refused by a
 * policy, tokens, estimated cost and latency percentiles; the daily series
 * (UTC days) carries requests, tokens and cost per group. Everything is
 * limited to what the session may read (lib/usage.js logsScope).
 *
 * The estimated environmental impact (migration 032, lib/impacts) adds up
 * as ranges: emissions, energy and water, low and high ends apart, over the
 * requests that have an estimate; `missing` counts the requests with output
 * whose model has none, so a total never passes for complete when it is
 * not. The daily series carries the middle of the emissions range.
 */

import { badRequest, isUuid } from './route.js'
import { logsScope } from './usage.js'

export const DIMENSIONS = ['team', 'agent', 'app', 'user', 'model', 'provider', 'label']

// Reasons a gateway refuses a request because of the team's policy or quota,
// not because something failed.
export const POLICY_REASONS = [
  'no_policy', 'team_disabled', 'provider_not_allowed', 'model_not_allowed',
  'quota_exceeded', 'sensitive_data_detected', 'agent_model_mismatch', 'model_disabled',
]

const KEY = {
  team:     `r.team_id::text`,
  agent:    `r.agent_id::text`,
  app:      `r.agent_id::text`,
  user:     `r.user_id::text`,
  // Refused before a provider was chosen: no provider (NULL, "Sin asignar").
  model:    `NULLIF(r.provider, '') || '/' || r.model_id`,
  provider: `NULLIF(r.provider, '')`,
  label:    `l.label`,
}

// The rows to group: one per label of each request when grouping by label.
const FROM = {
  label: `request_logs r CROSS JOIN LATERAL unnest(r.labels) AS l(label)`,
}
const source = by => FROM[by] ?? 'request_logs r'

const LABEL_RE = /^[a-z0-9_]{1,40}$/

// Rows that belong to the dimension at all, also when it is the filter: an
// agent's own work is apart from what an application did for people.
const PRESENT = {
  team: 'TRUE',
  agent: 'r.agent_id IS NOT NULL AND r.user_id IS NULL',
  app: 'r.agent_id IS NOT NULL AND r.user_id IS NOT NULL',
  user: 'r.user_id IS NOT NULL', model: 'TRUE', provider: 'TRUE',
  label: 'cardinality(r.labels) > 0',
}
const IDS = ['team', 'agent', 'app', 'user'] // uuid keys, with names

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
    if (IDS.includes(kind) && !isUuid(v)) throw badRequest(`${kind} inválido.`)
    if (v.length > 200) throw badRequest(`${kind} inválido.`)
    if (kind === 'label' && !LABEL_RE.test(v)) throw badRequest('label inválido.')
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
    parts.push(filter.kind === 'label'
      ? `$${params.length} = ANY(r.labels)`
      : `${KEY[filter.kind]} = $${params.length}`, PRESENT[filter.kind])
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
  MAX(r.created_at)                                            AS last_at,
  SUM(r.impact_gwp_g_min)                                      AS gwp_min,
  SUM(r.impact_gwp_g_max)                                      AS gwp_max,
  SUM(r.impact_energy_wh_min)                                  AS energy_min,
  SUM(r.impact_energy_wh_max)                                  AS energy_max,
  SUM(r.impact_water_ml_min)                                   AS water_min,
  SUM(r.impact_water_ml_max)                                   AS water_max,
  COUNT(*) FILTER (WHERE r.impact_method IS NOT NULL)          AS impact_estimated,
  COUNT(*) FILTER (WHERE r.impact_method IS NULL AND r.tokens_output > 0) AS impact_missing,
  COALESCE(SUM(r.tokens_output) FILTER (WHERE r.impact_method IS NOT NULL), 0) AS impact_tokens_out`

// How many people an application acted for: only where it is shown.
const PEOPLE = `,
  COUNT(DISTINCT r.user_id)                                    AS people`

function aggregates(params, by) {
  params.push(POLICY_REASONS)
  return AGGREGATES.replace('$POLICY', `$${params.length}`) + (by === 'app' ? PEOPLE : '')
}

const range = (lo, hi) => (lo == null ? null : { min: num(lo), max: num(hi) })

const shape = r => ({
  requests: num(r.requests), errors: num(r.errors), blocked: num(r.blocked),
  tokens_in: num(r.tokens_in), tokens_out: num(r.tokens_out), cost: num(r.cost),
  p50_ms: r.p50_ms == null ? null : Math.round(num(r.p50_ms)),
  p95_ms: r.p95_ms == null ? null : Math.round(num(r.p95_ms)),
  last_at: r.last_at ?? null,
  ...(r.people == null ? {} : { people: num(r.people) }),
  // null ranges: nothing in the group has an estimate.
  impact: {
    gwp_g: range(r.gwp_min, r.gwp_max),
    energy_wh: range(r.energy_min, r.energy_max),
    water_ml: range(r.water_min, r.water_max),
    estimated: num(r.impact_estimated),
    missing: num(r.impact_missing),
    tokens_out: num(r.impact_tokens_out),
  },
})

/**
 * Names for team, agent, application and person keys: from this
 * organization, and for a team manager from their team only (a name is not
 * shown to whom may not read it, even when the id was guessed). An
 * application is the exception: it acts for people of every team, and a
 * manager sees their people's use of it by its name.
 */
async function labels(db, session, kind, keys) {
  if (!keys.length) return new Map()
  const table = { team: 'teams', agent: 'agents', app: 'agents', user: 'users' }[kind]
  if (!table) return new Map(keys.map(k => [k, k]))
  const name = kind === 'user' ? `COALESCE(NULLIF(name, ''), email)` : 'name'
  const params = [session.orgId, keys]
  let scope = ''
  if (session.scope === 'team' && kind !== 'app') {
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
  const at = aggregates(pt, by)
  const pr = []
  const wr = where(session, q, pr)
  const ar = aggregates(pr, by)
  const pd = []
  const wd = where(session, q, pd)

  const [totals, rows, days] = await Promise.all([
    db.query(`SELECT ${at} FROM request_logs r WHERE ${wt}`, pt),
    db.query(`
      SELECT ${KEY[by]} AS key, ${ar}
        FROM ${source(by)}
       WHERE ${wr}
       GROUP BY 1
       ORDER BY cost DESC, requests DESC
       LIMIT 200`, pr),
    db.query(`
      SELECT to_char(date_trunc('day', r.created_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day,
             ${KEY[by]} AS key,
             COUNT(*)                                     AS requests,
             COALESCE(SUM(r.tokens_input + r.tokens_output), 0) AS tokens,
             COALESCE(SUM(r.cost_usd), 0)                 AS cost,
             COALESCE(SUM((r.impact_gwp_g_min + r.impact_gwp_g_max) / 2), 0) AS co2
        FROM ${source(by)}
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
      label: r.key == null ? 'Sin asignar' : names.get(r.key) ?? (IDS.includes(by) ? 'Eliminado' : r.key),
      ...shape(r),
    })),
    days: days.rows.map(d => ({ day: d.day, key: d.key, requests: num(d.requests), tokens: num(d.tokens), cost: num(d.cost), co2: num(d.co2) })),
  }
}
