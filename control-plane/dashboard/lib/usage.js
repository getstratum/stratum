/**
 * lib/usage.js — period parsing and the scope filter for request_logs reads.
 */

import { badRequest } from './route.js'

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/
const MONTH_RE = /^(\d{4})-(\d{2})$/

/** { from, to } from ?from&to (days) or ?period=YYYY-MM; default this month. */
export function parseDateRange(searchParams) {
  const from = searchParams.get('from')
  const to = searchParams.get('to')
  const period = searchParams.get('period')
  if (from && to) {
    if (!DAY_RE.test(from) || !DAY_RE.test(to)) throw badRequest('Fechas inválidas (AAAA-MM-DD).')
    return { from: new Date(`${from}T00:00:00Z`), to: new Date(`${to}T23:59:59.999Z`) }
  }
  if (period) {
    const m = MONTH_RE.exec(period)
    if (!m || Number(m[2]) < 1 || Number(m[2]) > 12) throw badRequest('Período inválido (AAAA-MM).')
    const y = Number(m[1]), mo = Number(m[2])
    return { from: new Date(Date.UTC(y, mo - 1, 1)), to: new Date(Date.UTC(y, mo, 1) - 1) }
  }
  const now = new Date()
  return {
    from: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)),
    to:   new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1) - 1),
  }
}

/**
 * SQL conditions limiting request_logs (aliased `alias`) to what the session
 * may read. Appends its parameters to `params`.
 */
export function logsScope(session, alias, params) {
  params.push(session.orgId)
  let sql = `${alias}.org_id = $${params.length}`
  if (session.scope === 'team') {
    params.push(session.teamId)
    sql += ` AND ${alias}.team_id = $${params.length}`
  }
  return sql
}
