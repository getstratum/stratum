/**
 * Authentication of gateways (data plane instances) by their sync token,
 * for the routes they call: /api/internal/sync and /api/internal/usage.
 */

import { createHash } from 'crypto'

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
