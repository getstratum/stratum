/**
 * lib/org-deletion.js — deleting an organization in two steps (ADR-0020,
 * migration 047), and the platform audit log.
 *
 *   1. markForDeletion: whoever runs the installation types the
 *      organization's name to confirm. It is suspended at once (nobody of it
 *      signs in, gateways refuse its requests) and kept whole for
 *      GRACE_DAYS, during which undoDeletion puts it back as it was.
 *   2. purgeDue, from the daily maintenance: once the days are over, every
 *      row of the organization goes, its audit log included. platform_audit
 *      keeps that it existed, what it had and its usage per month.
 *
 * Runs in Next.js and in scripts/stratum-admin.mjs. markForDeletion and
 * undoDeletion take one connection (they run a transaction on it); purgeDue
 * takes a pool. Their errors are for whoever runs the installation, in
 * English like the rest of the CLI.
 */

export const GRACE_DAYS = 30
export const MAINTENANCE = 'maintenance'

/** One entry of the platform audit log: what was done to an organization from outside it. */
export async function platformAudit(db, { actor, action, orgId = null, orgName = null, details = {} }) {
  await db.query(
    'INSERT INTO platform_audit (actor, action, org_id, org_name, details) VALUES ($1, $2, $3, $4, $5)',
    [actor, action, orgId, orgName, JSON.stringify(details)])
}

// The organization's own audit log, which its Owner, Admins and Auditors read.
async function orgAudit(db, orgId, actor, action, details) {
  await db.query(
    `INSERT INTO audit_log (org_id, actor_label, action, target_type, target_id, result, details)
     VALUES ($1::uuid, $2, $3, 'organization', $1::text, 'ok', $4)`,
    [orgId, actor, action, JSON.stringify(details)])
}

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

function checkReason(reason) {
  const r = (reason ?? '').trim()
  if (r.length < 5) throw new Error('A reason is required: at least 5 characters, kept in the audit logs.')
  return r
}

/**
 * Marks an organization for deletion. `confirmName` must be its name, as
 * written. Returns { name, deleteAfter }.
 */
export async function markForDeletion(db, { orgId, confirmName, reason, actor }) {
  const why = checkReason(reason)
  return inTransaction(db, async () => {
    const { rows } = await db.query(
      'SELECT id, name, status, delete_after FROM organizations WHERE id = $1 FOR UPDATE', [orgId])
    const org = rows[0]
    if (!org) throw new Error(`No organization with id ${orgId}.`)
    if (org.delete_after) throw new Error(`${org.name} is already marked for deletion, on ${org.delete_after.toISOString()}.`)
    if ((confirmName ?? '').trim() !== org.name.trim()) {
      throw new Error('The name to confirm does not match the organization\'s name, as written (org-list shows it).')
    }
    const { rows: [u] } = await db.query(
      `UPDATE organizations
          SET status_before_delete = status, status = 'suspended',
              delete_after = now() + make_interval(days => $2)
        WHERE id = $1 RETURNING delete_after`, [org.id, GRACE_DAYS])
    const details = { reason: why, delete_after: u.delete_after, status_before: org.status }
    await orgAudit(db, org.id, actor, 'org.delete', details)
    await platformAudit(db, { actor, action: 'org.delete', orgId: org.id, orgName: org.name, details })
    return { name: org.name, deleteAfter: u.delete_after }
  })
}

/**
 * Undoes markForDeletion while the organization is still there (the
 * maintenance has not deleted it yet): back to the state it had before.
 * Returns { name, status }.
 */
export async function undoDeletion(db, { orgId, reason, actor }) {
  const why = checkReason(reason)
  return inTransaction(db, async () => {
    const { rows } = await db.query(
      'SELECT id, name, delete_after, status_before_delete FROM organizations WHERE id = $1 FOR UPDATE', [orgId])
    const org = rows[0]
    if (!org) throw new Error(`No organization with id ${orgId}: if it was marked for deletion, it is already deleted.`)
    if (!org.delete_after) throw new Error(`${org.name} is not marked for deletion.`)
    const status = org.status_before_delete === 'suspended' ? 'suspended' : 'active'
    await db.query(
      `UPDATE organizations SET status = $2, delete_after = NULL, status_before_delete = NULL WHERE id = $1`,
      [org.id, status])
    const details = { reason: why, status }
    await orgAudit(db, org.id, actor, 'org.undelete', details)
    await platformAudit(db, { actor, action: 'org.undelete', orgId: org.id, orgName: org.name, details })
    return { name: org.name, status }
  })
}

/**
 * Deletes every organization whose days are over. Requests go first, in
 * batches and outside the transaction (they are most of the rows); the rest
 * in one transaction per organization, which deletes the requests that
 * arrived meanwhile, the alerts and the audit log (neither cascades), the
 * organization (everything else cascades from it) and the sync tombstones
 * its rows left on the way. Two replicas at once: the second skips the
 * organization the first is deleting.
 *
 * Returns, per organization deleted: { orgId, name, counts }.
 */
export async function purgeDue(pool, { batch = 5000 } = {}) {
  const { rows: due } = await pool.query(
    'SELECT id FROM organizations WHERE delete_after IS NOT NULL AND delete_after <= now() ORDER BY delete_after')
  const out = []
  for (const { id } of due) {
    for (;;) {
      const r = await pool.query(`
        DELETE FROM request_logs
         WHERE org_id = $1 AND (id, created_at) IN (
           SELECT id, created_at FROM request_logs WHERE org_id = $1 LIMIT $2)
           -- Undone meanwhile: stop.
           AND EXISTS (SELECT 1 FROM organizations o WHERE o.id = $1 AND o.delete_after <= now())`, [id, batch])
      if (r.rowCount < batch) break
    }
    const client = await pool.connect()
    try {
      const done = await inTransaction(client, async () => {
        const { rows } = await client.query(
          `SELECT id, name, delete_after FROM organizations
            WHERE id = $1 AND delete_after IS NOT NULL AND delete_after <= now()
            FOR UPDATE SKIP LOCKED`, [id])
        const org = rows[0]
        if (!org) return null // undone meanwhile, or another replica has it
        const { rows: [counts] } = await client.query(`
          SELECT (SELECT count(*) FROM users WHERE org_id = $1)::int                AS people,
                 (SELECT count(*) FROM agents WHERE org_id = $1)::int               AS agents,
                 (SELECT count(*) FROM teams WHERE org_id = $1)::int                AS teams,
                 (SELECT count(*) FROM data_plane_instances WHERE org_id = $1)::int AS gateways`, [org.id])
        // Its usage per month, for whoever bills it after it is gone.
        const { rows: usage } = await client.query(`
          SELECT to_char(month, 'YYYY-MM') AS month, sum(tokens)::bigint AS tokens,
                 round(sum(cost_usd), 2)::float8 AS cost_usd, sum(requests)::bigint AS requests
            FROM team_usage_monthly WHERE org_id = $1 GROUP BY month ORDER BY month`, [org.id])
        await client.query('DELETE FROM request_logs WHERE org_id = $1', [org.id])
        await client.query('DELETE FROM alerts WHERE org_id = $1', [org.id])
        await client.query('DELETE FROM audit_log WHERE org_id = $1', [org.id])
        await client.query('DELETE FROM organizations WHERE id = $1', [org.id])
        await client.query('DELETE FROM stratum_sync_tombstones WHERE org_id = $1', [org.id])
        await platformAudit(client, {
          actor: MAINTENANCE, action: 'org.purge', orgId: org.id, orgName: org.name,
          details: { marked_until: org.delete_after, counts, usage: usage.map(u => ({ ...u, tokens: Number(u.tokens), requests: Number(u.requests) })) },
        })
        return { orgId: org.id, name: org.name, counts }
      })
      if (done) out.push(done)
    } finally {
      client.release()
    }
  }
  return out
}
