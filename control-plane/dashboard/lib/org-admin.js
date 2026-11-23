/**
 * lib/org-admin.js — what whoever runs the installation does to its
 * organizations (ADR-0020): list, create, suspend, resume, set the plan.
 * Deleting is in lib/org-deletion.js. The same functions serve
 * scripts/stratum-admin.mjs and the platform API (app/api/platform), so
 * both write the same audit entries: one in platform_audit, and one in the
 * organization's own log while it exists.
 *
 * The functions that change something take one connection (they run a
 * transaction on it) and an `actor` for the audit logs. Errors are
 * HttpErrors in English.
 */

import { HttpError } from './http-error.js'
import { mergeLimits, countAll } from './org-limits.js'
import { platformAudit } from './org-deletion.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const MAX_NAME = 255
export const MAX_PLAN = 100

async function inTransaction(db, fn) {
  await db.query('BEGIN')
  try {
    const out = await fn()
    await db.query('COMMIT')
    return out
  } catch (err) {
    await db.query('ROLLBACK').catch(() => {})
    throw err
  }
}

async function orgAudit(db, orgId, actor, action, details) {
  await db.query(
    `INSERT INTO audit_log (org_id, actor_label, action, target_type, target_id, result, details)
     VALUES ($1::uuid, $2, $3, 'organization', $1::text, 'ok', $4)`,
    [orgId, actor, action, JSON.stringify(details)])
}

export function reasonOf(reason) {
  const r = typeof reason === 'string' ? reason.trim() : ''
  if (r.length < 5) throw new HttpError(400, 'reason_required', 'A reason is required: at least 5 characters, kept in the audit logs.')
  return r.slice(0, 500)
}

function nameOf(name) {
  const n = typeof name === 'string' ? name.trim() : ''
  if (!n || n.length > MAX_NAME) throw new HttpError(400, 'bad_name', `The organization needs a name (up to ${MAX_NAME} characters).`)
  return n
}

// undefined: unchanged; null or '': none.
function planOf(plan) {
  if (plan === undefined) return undefined
  if (plan === null) return null
  if (typeof plan !== 'string') throw new HttpError(400, 'bad_plan', 'plan is a name or null.')
  return plan.trim().slice(0, MAX_PLAN) || null
}

function limitsOf(current, changes) {
  if (changes === undefined) return current
  if (changes === null || typeof changes !== 'object' || Array.isArray(changes)) {
    throw new HttpError(400, 'bad_limits', 'limits is an object: each limit a number, or null to remove it.')
  }
  try {
    return mergeLimits(current, changes)
  } catch (err) {
    throw new HttpError(400, 'bad_limits', err.message)
  }
}

async function lockOrg(db, orgId) {
  if (!UUID.test(String(orgId))) throw new HttpError(404, 'not_found', `No organization with id ${orgId}.`)
  const { rows } = await db.query(
    'SELECT id, name, status, limits, plan_name, delete_after FROM organizations WHERE id = $1 FOR UPDATE', [orgId])
  if (!rows[0]) throw new HttpError(404, 'not_found', `No organization with id ${orgId}.`)
  return rows[0]
}

// What whoever runs the installation sees of an organization: never its
// people, policies, credentials or requests (ADR-0020).
const ORG_COLUMNS = `o.id, o.name, o.status, o.plan_name AS plan, o.limits, o.delete_after, o.created_at`

/** Every organization, with how many people, agents, teams and gateways it has. */
export async function listOrgs(db) {
  const { rows } = await db.query(`
    SELECT ${ORG_COLUMNS},
           (SELECT count(*) FROM users u WHERE u.org_id = o.id AND COALESCE(u.is_active, true))::int  AS people,
           (SELECT count(*) FROM agents a WHERE a.org_id = o.id AND COALESCE(a.is_active, true))::int AS agents,
           (SELECT count(*) FROM teams t WHERE t.org_id = o.id)::int                                AS teams,
           (SELECT count(*) FROM data_plane_instances d WHERE d.org_id = o.id AND NOT d.disabled)::int AS gateways
      FROM organizations o ORDER BY o.created_at`)
  return rows.map(o => ({
    id: o.id, name: o.name, status: o.status, plan: o.plan, limits: o.limits,
    delete_after: o.delete_after, created_at: o.created_at,
    counts: { people: o.people, agents: o.agents, teams: o.teams, gateways: o.gateways },
  }))
}

/** One organization, with what it has against each limit; null if there is none. */
export async function getOrg(db, orgId) {
  if (!UUID.test(String(orgId))) return null
  const { rows } = await db.query(`SELECT ${ORG_COLUMNS} FROM organizations o WHERE o.id = $1`, [orgId])
  if (!rows[0]) return null
  return { ...rows[0], counts: await countAll(db, orgId) }
}

/** A new organization, without people: its first Owner comes by invitation or with create-owner. */
export async function createOrg(db, { name, plan, limits, actor }) {
  const n = nameOf(name)
  const p = planOf(plan) ?? null
  const l = limitsOf({}, limits ?? {})
  return inTransaction(db, async () => {
    const { rows: dup } = await db.query('SELECT id FROM organizations WHERE lower(name) = lower($1)', [n])
    if (dup[0]) throw new HttpError(409, 'name_taken', `There is already an organization called ${n} (${dup[0].id}).`)
    const { rows: [o] } = await db.query(
      'INSERT INTO organizations (name, limits, plan_name) VALUES ($1, $2, $3) RETURNING id', [n, l, p])
    const details = { plan: p, limits: l }
    await orgAudit(db, o.id, actor, 'org.create', details)
    await platformAudit(db, { actor, action: 'org.create', orgId: o.id, orgName: n, details })
    return { id: o.id, name: n }
  })
}

/** Suspends or resumes; { name, changed }. */
export async function setStatus(db, { orgId, status, reason, actor }) {
  const why = reasonOf(reason)
  return inTransaction(db, async () => {
    const org = await lockOrg(db, orgId)
    if (org.delete_after) throw new HttpError(409, 'marked_for_deletion', `${org.name} is marked for deletion: undo that first.`)
    if (org.status === status) return { name: org.name, changed: false }
    await db.query('UPDATE organizations SET status = $2 WHERE id = $1', [org.id, status])
    const action = status === 'suspended' ? 'org.suspend' : 'org.resume'
    await orgAudit(db, org.id, actor, action, { reason: why })
    await platformAudit(db, { actor, action, orgId: org.id, orgName: org.name, details: { reason: why } })
    return { name: org.name, changed: true }
  })
}

/**
 * Changes the plan's name, its limits (merged: a limit set to null goes)
 * and the organization's name; any of them may be left out. Returns the
 * organization as it is now.
 */
export async function setPlan(db, { orgId, plan, limits, name, actor }) {
  const p = planOf(plan)
  const n = name === undefined ? undefined : nameOf(name)
  return inTransaction(db, async () => {
    const org = await lockOrg(db, orgId)
    const next = {
      limits: limitsOf(org.limits, limits),
      plan: p === undefined ? org.plan_name : p,
      name: n ?? org.name,
    }
    if (n && n.toLowerCase() !== org.name.toLowerCase()) {
      const { rows: dup } = await db.query('SELECT 1 FROM organizations WHERE lower(name) = lower($1) AND id <> $2', [n, org.id])
      if (dup[0]) throw new HttpError(409, 'name_taken', `There is already an organization called ${n}.`)
    }
    const same = JSON.stringify(next.limits) === JSON.stringify(org.limits) && next.plan === org.plan_name && next.name === org.name
    if (!same) {
      await db.query('UPDATE organizations SET limits = $2, plan_name = $3, name = $4 WHERE id = $1',
        [org.id, next.limits, next.plan, next.name])
      const details = {
        plan: { from: org.plan_name, to: next.plan }, limits: { from: org.limits, to: next.limits },
        ...(next.name !== org.name ? { name: { from: org.name, to: next.name } } : {}),
      }
      await orgAudit(db, org.id, actor, 'org.limits', details)
      await platformAudit(db, { actor, action: 'org.limits', orgId: org.id, orgName: next.name, details })
    }
    return { id: org.id, name: next.name, plan: next.plan, limits: next.limits, changed: !same }
  })
}

/**
 * Each organization's usage in a UTC month ('YYYY-MM'), for billing: tokens,
 * estimated cost and requests from team_usage_monthly, and what it has now.
 * Organizations without usage that month are listed too, with zeros.
 */
export async function usageByMonth(db, month) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month ?? '')) throw new HttpError(400, 'bad_month', 'month is YYYY-MM.')
  const { rows } = await db.query(`
    SELECT o.id, o.name, o.status, o.plan_name AS plan,
           COALESCE(sum(u.tokens), 0)::bigint                AS tokens,
           round(COALESCE(sum(u.cost_usd), 0), 2)::float8   AS cost_usd,
           COALESCE(sum(u.requests), 0)::bigint              AS requests
      FROM organizations o
      LEFT JOIN team_usage_monthly u ON u.org_id = o.id AND u.month = to_date($1, 'YYYY-MM')
     GROUP BY o.id ORDER BY o.name`, [month])
  const orgs = await listOrgs(db)
  const counts = Object.fromEntries(orgs.map(o => [o.id, o.counts]))
  return rows.map(r => ({
    id: r.id, name: r.name, status: r.status, plan: r.plan, month,
    tokens: Number(r.tokens), cost_usd: r.cost_usd, requests: Number(r.requests),
    ...counts[r.id],
  }))
}
