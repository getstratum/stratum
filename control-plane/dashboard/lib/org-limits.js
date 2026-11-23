/**
 * lib/org-limits.js — the limits an organization's plan sets (ADR-0020,
 * migration 046), which its own administrators cannot change or exceed.
 *
 *   - people, agents, teams, gateways: the console refuses to create one
 *     more, or to turn one back on, past the limit (409 plan_limit). Lowering
 *     a limit never removes anything: the organization just cannot add more.
 *   - monthly_tokens, monthly_budget_usd: every team together. They go to
 *     gateways with each sync (lib/sync.js), which refuse requests past them
 *     (org_quota_exceeded, org_budget_exceeded).
 *   - retention_days: the daily maintenance deletes older requests
 *     (applyRetention, from instrumentation.js).
 *
 * A limit that is not set does not exist: an organization with '{}' (every
 * one until someone sets a plan) works as before.
 *
 * Runs in Next.js and in scripts/stratum-admin.mjs, so it does not import
 * lib/route.js.
 */

import { HttpError } from './http-error.js'

export const MIN_RETENTION_DAYS = 31

// count: how many the organization has now ($1 = org id).
export const LIMITS = {
  people: {
    label: n => n === 1 ? 'persona activa' : 'personas activas',
    count: 'SELECT count(*)::int AS n FROM users WHERE org_id = $1 AND COALESCE(is_active, true)',
  },
  agents: {
    label: n => n === 1 ? 'agente activo' : 'agentes activos',
    count: 'SELECT count(*)::int AS n FROM agents WHERE org_id = $1 AND COALESCE(is_active, true)',
  },
  teams: {
    label: n => n === 1 ? 'equipo' : 'equipos',
    count: 'SELECT count(*)::int AS n FROM teams WHERE org_id = $1',
  },
  gateways: {
    label: n => n === 1 ? 'gateway' : 'gateways',
    count: 'SELECT count(*)::int AS n FROM data_plane_instances WHERE org_id = $1 AND NOT disabled',
  },
  monthly_tokens:     { label: () => 'tokens por mes' },
  monthly_budget_usd: { label: () => 'US$ por mes', decimal: true },
  retention_days:     { label: n => n === 1 ? 'día de retención' : 'días de retención', min: MIN_RETENTION_DAYS },
}

/**
 * Validates limits to set on top of `current`. Each key of `changes` is a
 * limit: a number sets it, null removes it. Returns the new object, or
 * throws an Error that says what is wrong.
 */
export function mergeLimits(current, changes) {
  const out = { ...(current ?? {}) }
  for (const [key, raw] of Object.entries(changes ?? {})) {
    const def = LIMITS[key]
    if (!def) throw new Error(`Unknown limit "${key}". Limits: ${Object.keys(LIMITS).join(', ')}.`)
    if (raw === null) { delete out[key]; continue }
    const n = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw
    const ok = typeof n === 'number' && Number.isFinite(n) && n >= 0 && (def.decimal || Number.isInteger(n))
    if (!ok) throw new Error(`${key} must be ${def.decimal ? 'a number' : 'a whole number'}, 0 or more.`)
    if (def.min && n < def.min) throw new Error(`${key} must be at least ${def.min}.`)
    out[key] = def.decimal ? Math.round(n * 100) / 100 : n
  }
  return out
}

export async function loadLimits(db, orgId) {
  const { rows } = await db.query('SELECT limits, plan_name FROM organizations WHERE id = $1', [orgId])
  return { limits: rows[0]?.limits ?? {}, plan: rows[0]?.plan_name ?? null }
}

/** What the organization has now of each limit it can count. */
export async function countAll(db, orgId) {
  const out = {}
  for (const [key, def] of Object.entries(LIMITS)) {
    if (def.count) out[key] = (await db.query(def.count, [orgId])).rows[0].n
  }
  return out
}

/** "Fijado por tu plan (Empresa): 25 personas activas", for a limit the organization reached. */
export function planHint(kind, max, plan) {
  return `Fijado por tu plan${plan ? ` (${plan})` : ''}: ${max} ${LIMITS[kind].label(max)}.`
}

/**
 * The organization's plan as its console shows it: the limits, what it has
 * of each (tokens and spend: this UTC month, every team together), and the
 * countable ones it reached. `managed` is false for an organization nobody
 * set a plan or a limit for: the console then shows none of this.
 */
export async function planState(db, orgId) {
  const { limits, plan } = await loadLimits(db, orgId)
  const counts = await countAll(db, orgId)
  const { rows: [m] } = await db.query(
    `SELECT COALESCE(sum(tokens), 0)::bigint AS tokens, COALESCE(sum(cost_usd), 0)::float8 AS cost_usd
       FROM team_usage_monthly
      WHERE org_id = $1 AND month = date_trunc('month', now() AT TIME ZONE 'UTC')::date`, [orgId])
  counts.monthly_tokens = Number(m.tokens)
  counts.monthly_budget_usd = Math.round(m.cost_usd * 100) / 100
  const reached = {}
  for (const kind of ['people', 'agents', 'teams', 'gateways']) {
    if (limits[kind] != null && counts[kind] >= limits[kind]) reached[kind] = planHint(kind, limits[kind], plan)
  }
  return { plan, limits, counts, reached, managed: plan != null || Object.keys(limits).length > 0 }
}

export function planLimitError(kind, max, plan) {
  const which = plan ? `tu plan (${plan})` : 'tu plan'
  return new HttpError(409, 'plan_limit',
    `Llegaste al límite de ${which}: ${max} ${LIMITS[kind].label(max)}. ` +
    'Para sumar más, pedile un cambio de plan a quien administra Stratum.')
}

/**
 * Throws 409 plan_limit when the organization cannot have `adding` more of
 * `kind`. Call it where two requests cannot both pass it: inside withRoom,
 * or in a transaction that holds the same lock (lockKey).
 */
export async function assertRoom(db, orgId, kind, adding = 1) {
  const { limits, plan } = await loadLimits(db, orgId)
  const max = limits[kind]
  if (max == null) return
  const { rows } = await db.query(LIMITS[kind].count, [orgId])
  if (rows[0].n + adding > max) throw planLimitError(kind, max, plan)
}

// The lock that serializes what changes a count. People share the one the
// people routes already take (app/api/users/[id]/route.js).
export const lockKey = (kind, orgId) => kind === 'people' ? `org-users:${orgId}` : `org-limit:${kind}:${orgId}`

/**
 * Runs fn(db) once the organization has room for one more `kind`. Without a
 * limit for it, fn runs as it always did, on the pool; with one, in a
 * transaction that holds the kind's lock, so two requests cannot both take
 * the last place.
 */
export async function withRoom(pool, orgId, kind, fn) {
  const { limits } = await loadLimits(pool, orgId)
  if (limits[kind] == null) return fn(pool)
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [lockKey(kind, orgId)])
    await assertRoom(client, orgId, kind)
    const out = await fn(client)
    await client.query('COMMIT')
    return out
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

/**
 * The daily maintenance: deletes the requests (request_logs) and task
 * results (task_outcomes) of each organization older than its
 * retention_days, in batches so no statement holds locks for long. The
 * month's usage per team (team_usage_monthly), which quotas, budgets and
 * billing read, is kept. Returns what it deleted, per organization.
 */
export async function applyRetention(db, { batch = 5000 } = {}) {
  const { rows: orgs } = await db.query(`
    SELECT id, (limits->>'retention_days')::int AS days
      FROM organizations
     WHERE limits ? 'retention_days' AND (limits->>'retention_days')::int >= $1`, [MIN_RETENTION_DAYS])
  const out = []
  for (const o of orgs) {
    const deleted = { orgId: o.id, days: o.days, requests: 0, outcomes: 0 }
    for (;;) {
      const r = await db.query(`
        DELETE FROM request_logs
         WHERE org_id = $1 AND (id, created_at) IN (
           SELECT id, created_at FROM request_logs
            WHERE org_id = $1 AND created_at < now() - make_interval(days => $2)
            LIMIT $3)`, [o.id, o.days, batch])
      deleted.requests += r.rowCount
      if (r.rowCount < batch) break
    }
    for (;;) {
      const r = await db.query(`
        DELETE FROM task_outcomes
         WHERE id IN (
           SELECT id FROM task_outcomes
            WHERE org_id = $1 AND created_at < now() - make_interval(days => $2)
            LIMIT $3)`, [o.id, o.days, batch])
      deleted.outcomes += r.rowCount
      if (r.rowCount < batch) break
    }
    if (deleted.requests || deleted.outcomes) out.push(deleted)
  }
  return out
}
