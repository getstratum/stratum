/**
 * lib/audit.js — writes to audit_log (append-only, migration 016).
 *
 * Every change made through the console and every request refused by a
 * permission check is recorded. Audit writes never fail the request that
 * produced them: if one cannot be written the error is logged loudly.
 */

/**
 * The client address. Each trusted proxy appends the address it saw to
 * X-Forwarded-For, so the client is the entry STRATUM_TRUSTED_PROXY_HOPS
 * places from the right: 1 behind one reverse proxy (Caddy, nginx), 2 behind
 * Google Cloud's load balancer (it appends the client and its own address).
 * Entries further left are whatever the client sent and are not trusted.
 */
export function clientIp(req) {
  const fwd = req.headers.get('x-forwarded-for')
  if (fwd) {
    const parts = fwd.split(',').map(s => s.trim()).filter(Boolean)
    const hops = Math.max(1, parseInt(process.env.STRATUM_TRUSTED_PROXY_HOPS ?? '1', 10) || 1)
    const entry = parts[Math.max(0, parts.length - hops)]
    if (entry) return entry.slice(0, 64)
  }
  return req.headers.get('x-real-ip')?.slice(0, 64) ?? null
}

/**
 * @param {import('pg').Pool | import('pg').PoolClient} db
 * @param {object} e
 * @param {Request} [e.req]
 * @param {object} [e.session]   lib/session.js session (actor and org)
 * @param {string} [e.orgId]     when there is no session (failed sign-in)
 * @param {string} [e.actor]     label when there is no session
 * @param {string} e.action      e.g. 'user.update', 'session.login'
 * @param {string} [e.targetType]
 * @param {string} [e.targetId]
 * @param {'ok'|'denied'|'failed'} [e.result]
 * @param {object} [e.details]   never secrets
 */
export async function audit(db, e) {
  const s = e.session
  try {
    await db.query(
      `INSERT INTO audit_log
         (org_id, actor_user_id, actor_label, actor_role, action, target_type, target_id,
          result, ip, user_agent, details)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        s?.orgId ?? e.orgId ?? null,
        s?.userId ?? null,
        s?.email ?? e.actor ?? null,
        s?.role ?? null,
        e.action,
        e.targetType ?? null,
        e.targetId != null ? String(e.targetId) : null,
        e.result ?? 'ok',
        e.req ? clientIp(e.req) : null,
        e.req?.headers.get('user-agent')?.slice(0, 300) ?? null,
        JSON.stringify(e.details ?? {}),
      ])
  } catch (err) {
    console.error(`[audit] could not record ${e.action} (${e.result ?? 'ok'}): ${err.message}`)
  }
}
