/**
 * lib/usage-report.js — usage reports an application asks for on behalf of
 * a person it signed in (GET /api/oidc/usage-report), for a chat portal to
 * make a PDF of, say.
 *
 *   self  the person's own usage: what they did with their keys and what
 *         applications did on their behalf
 *   team  for a team manager, their team's usage added up: by model, by
 *         day, by label, people against agents, how many people. Never who
 *         used how much: no person's name, id or share. Not given while
 *         fewer than MIN_PEOPLE people used anything in the period (with
 *         two, the total less one's own is the other's).
 *
 * The person is checked here, not by the application: active, allowed to
 * use applications, in the application's organization; and for a team
 * report, a team manager now. The application has to be allowed to ask
 * (oidc_clients.usage_reports, 033).
 */

import { POLICY_REASONS } from './consumption.js'

export const MIN_PEOPLE = 3
export const KINDS = ['self', 'team']
const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/

export class ReportError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message)
    this.status = status
    this.code = code
    this.extra = extra
  }
}

/** A month ("2026-10", UTC) as [from, to); not in the future, at most two years back. */
export function parseMonth(value, now = new Date()) {
  const m = MONTH_RE.exec(value ?? '')
  if (!m) throw new ReportError(400, 'invalid_month', 'month tiene que ser AAAA-MM.')
  const from = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, 1))
  const to = new Date(Date.UTC(Number(m[1]), Number(m[2]), 1))
  const thisMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
  const oldest = new Date(Date.UTC(now.getUTCFullYear() - 2, now.getUTCMonth(), 1))
  if (from > thisMonth) throw new ReportError(400, 'invalid_month', 'Ese mes todavía no empezó.')
  if (from < oldest) throw new ReportError(400, 'invalid_month', 'Hay reportes de los últimos dos años.')
  return { month: value, from, to }
}

/**
 * The person, as the console knows them now, and the reports they may have:
 * { person: { id, name, email }, self: true, team: { id, name } | null }.
 * null when the person may not use this application's organization.
 */
export async function reportScopes(db, client, personId) {
  const { rows: [u] } = await db.query(
    `SELECT u.id::text AS id, COALESCE(NULLIF(u.name, ''), u.email) AS name, u.email, u.role,
            t.id::text AS team_id, t.name AS team_name
       FROM users u
       JOIN organizations o ON o.id = u.org_id
       JOIN teams t ON t.id = u.team_id
      WHERE u.id = $1 AND u.org_id = $2 AND o.status = 'active'
        AND COALESCE(u.is_active, true) AND COALESCE(u.app_access, true)`,
    [personId, client.org_id])
  if (!u) return null
  return {
    person: { id: u.id, name: u.name, email: u.email },
    self: true,
    team: u.role === 'team_manager' ? { id: u.team_id, name: u.team_name } : null,
  }
}

const num = (v) => (v == null ? 0 : Number(v))
const range = (lo, hi) => (lo == null ? null : { min: num(lo), max: num(hi) })

const TOTALS = `
  COUNT(*)                                                AS requests,
  COUNT(*) FILTER (WHERE r.status_code >= 400)            AS errors,
  COUNT(*) FILTER (WHERE r.error_message = ANY($POLICY))  AS blocked,
  COALESCE(SUM(r.tokens_input), 0)                        AS tokens_in,
  COALESCE(SUM(r.tokens_output), 0)                       AS tokens_out,
  COALESCE(SUM(r.cost_usd), 0)                            AS cost,
  SUM(r.impact_gwp_g_min)                                 AS gwp_min,
  SUM(r.impact_gwp_g_max)                                 AS gwp_max,
  SUM(r.impact_energy_wh_min)                             AS energy_min,
  SUM(r.impact_energy_wh_max)                             AS energy_max,
  SUM(r.impact_water_ml_min)                              AS water_min,
  SUM(r.impact_water_ml_max)                              AS water_max,
  COUNT(*) FILTER (WHERE r.impact_method IS NULL AND r.tokens_output > 0) AS impact_missing`

const totals = (r) => ({
  requests: num(r.requests), errors: num(r.errors), blocked: num(r.blocked),
  tokens_in: num(r.tokens_in), tokens_out: num(r.tokens_out), cost: num(r.cost),
  impact: {
    gwp_g: range(r.gwp_min, r.gwp_max),
    energy_wh: range(r.energy_min, r.energy_max),
    water_ml: range(r.water_min, r.water_max),
    missing: num(r.impact_missing),
  },
})

/**
 * The report. Throws ReportError: 404 unknown_user, 403 not_team_manager,
 * 403 too_few_people (with how many).
 */
export async function usageReport(db, client, { personId, kind, month, now = new Date() }) {
  if (!KINDS.includes(kind)) throw new ReportError(400, 'invalid_kind', `kind tiene que ser uno de: ${KINDS.join(', ')}.`)
  const period = parseMonth(month, now)
  const scopes = await reportScopes(db, client, personId)
  if (!scopes) throw new ReportError(404, 'unknown_user', 'La persona no existe o no puede usar aplicaciones.')
  if (kind === 'team' && !scopes.team) {
    throw new ReportError(403, 'not_team_manager', 'Solo quien administra un equipo ve el consumo del equipo.')
  }

  const params = [client.org_id, period.from, period.to, POLICY_REASONS]
  let whose
  if (kind === 'self') {
    params.push(scopes.person.id)
    whose = `r.user_id = $5`
  } else {
    params.push(scopes.team.id)
    whose = `r.team_id = $5`
  }
  const where = `r.org_id = $1 AND r.created_at >= $2 AND r.created_at < $3 AND ${whose}`
  const T = TOTALS.replace('$POLICY', '$4')

  if (kind === 'team') {
    const { rows: [p] } = await db.query(
      `SELECT COUNT(DISTINCT r.user_id) AS people FROM request_logs r WHERE ${where.replace('$5', '$4')}`,
      [params[0], params[1], params[2], params[4]])
    const people = num(p.people)
    if (people < MIN_PEOPLE) {
      throw new ReportError(403, 'too_few_people',
        `El reporte del equipo se muestra cuando lo usaron al menos ${MIN_PEOPLE} personas en el mes, para que no se pueda deducir cuánto usó cada una.`,
        { people, min: MIN_PEOPLE })
    }
  }

  const q = (sql) => db.query(sql, params)
  const [tot, byModel, byDay, byLabel, split, budget] = await Promise.all([
    q(`SELECT ${T}${kind === 'team' ? ', COUNT(DISTINCT r.user_id) AS people' : ''} FROM request_logs r WHERE ${where}`),
    q(`SELECT NULLIF(r.provider, '') || '/' || r.model_id AS model, ${T}
         FROM request_logs r WHERE ${where} GROUP BY 1 ORDER BY cost DESC, requests DESC LIMIT 20`),
    q(`SELECT to_char(date_trunc('day', r.created_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day, ${T}
         FROM request_logs r WHERE ${where} GROUP BY 1 ORDER BY 1`),
    q(`SELECT l.label, ${T}
         FROM request_logs r CROSS JOIN LATERAL unnest(r.labels) AS l(label)
        WHERE ${where} GROUP BY 1 ORDER BY requests DESC LIMIT 15`),
    kind === 'team'
      ? q(`SELECT (r.user_id IS NOT NULL) AS people, ${T} FROM request_logs r WHERE ${where} GROUP BY 1`)
      : null,
    kind === 'team'
      ? db.query(`SELECT t.monthly_budget_usd AS budget, p.monthly_token_quota AS quota
                    FROM teams t LEFT JOIN policies p ON p.id = t.policy_id WHERE t.id = $1`, [scopes.team.id])
      : null,
  ])

  const t0 = tot.rows[0] ?? {}
  const report = {
    kind,
    month: period.month,
    from: period.from.toISOString(),
    to: period.to.toISOString(),
    generated_at: now.toISOString(),
    subject: kind === 'self' ? { name: scopes.person.name, email: scopes.person.email } : { name: scopes.team.name },
    totals: totals(t0),
    by_model: byModel.rows.map(r => ({ model: r.model ?? 'Sin asignar', ...totals(r) })),
    by_day: byDay.rows.map(r => ({ day: r.day, ...totals(r) })),
    by_label: byLabel.rows.map(r => ({ label: r.label, ...totals(r) })),
  }
  if (kind === 'team') {
    report.people = num(t0.people)
    const s = Object.fromEntries(split.rows.map(r => [r.people ? 'people' : 'agents', totals(r)]))
    report.split = { people: s.people ?? totals({}), agents: s.agents ?? totals({}) }
    const b = budget.rows[0] ?? {}
    report.limits = {
      budget_usd: b.budget == null ? null : num(b.budget),
      token_quota: b.quota == null ? null : num(b.quota),
    }
  }
  return report
}
