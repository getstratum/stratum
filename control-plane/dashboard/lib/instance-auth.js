/**
 * Authentication of gateways (data plane instances) by their sync token,
 * for the routes they call: /api/internal/sync and /api/internal/usage.
 */

import { createHash } from 'crypto'
import { gatewayVersion, RECENT_MINUTES } from './gateway-version.js'

export const hashSyncToken = (raw) => createHash('sha256').update(raw).digest('hex')

/**
 * The enabled instance whose sync token is in the Authorization header, or
 * null. `db` is anything with query(): the pool or a client.
 */
export async function authenticateInstance(db, authHeader) {
  if (!authHeader?.startsWith('Bearer ')) return null
  const raw = authHeader.slice(7)
  if (!raw) return null
  const { rows } = await db.query(
    `SELECT id, org_id FROM data_plane_instances
      WHERE sync_token_hash = $1 AND disabled = false
      LIMIT 1`,
    [hashSyncToken(raw)])
  return rows[0] ?? null
}

/**
 * A gateway synced: when, which configuration version it got, and which
 * software version it runs (from its User-Agent; see lib/gateway-version.js).
 * Versions not seen for RECENT_MINUTES are dropped, so the list is what runs
 * now, also while the replicas of one gateway are being upgraded.
 */
export async function recordSync(db, instanceId, configVersion, userAgent) {
  await db.query(`
    UPDATE data_plane_instances
       SET last_seen_at = now(),
           last_version = $1,
           gateway_versions = CASE WHEN $3::text IS NULL THEN gateway_versions ELSE (
             SELECT COALESCE(jsonb_object_agg(k, v), '{}'::jsonb)
               FROM jsonb_each(gateway_versions || jsonb_build_object($3::text, now())) AS e(k, v)
              WHERE (v #>> '{}')::timestamptz > now() - make_interval(mins => $4)
           ) END
     WHERE id = $2`,
    [configVersion, instanceId, gatewayVersion(userAgent), RECENT_MINUTES])
}
