/**
 * GET /api/internal/sync
 *
 * Canal de sync DP → CP para el data plane de stratum.
 * Autenticado con Bearer sync_token (generado al registrar la instancia).
 *
 * Query params:
 *   since_version  — versión monotónica desde la que el DP quiere delta
 *   instance_id    — ID de la instancia (dp_xxxx)
 *
 * v2: incluye provider_configs (con api_key en claro — solo para sync autenticado).
 * El cuerpo lo arma lib/sync.js (una transacción, todo cambio versionado).
 */

import { NextResponse } from 'next/server'
import { createHash } from 'crypto'
import { query, getDb } from '@/lib/db'
import { buildSyncResponse } from '@/lib/sync'
import { decryptSecret } from '@/lib/secrets'

import { tokenRoute } from '@/lib/route'

export const dynamic = 'force-dynamic'

const SYNC_INTERVAL_S = parseInt(process.env.STRATUM_SYNC_INTERVAL_S ?? '30', 10)

// ---------------------------------------------------------------------------
// Auth helpers
// ---------------------------------------------------------------------------

function hashSyncToken(rawToken) {
  return createHash('sha256').update(rawToken).digest('hex')
}

async function authenticateInstance(authHeader) {
  if (!authHeader?.startsWith('Bearer ')) return null
  const rawToken = authHeader.slice(7)
  if (!rawToken) return null
  const tokenHash = hashSyncToken(rawToken)

  const rows = await query(
    `SELECT id, org_id, disabled
     FROM data_plane_instances
     WHERE sync_token_hash = $1 AND disabled = false
     LIMIT 1`,
    [tokenHash]
  )
  return rows[0] ?? null
}

async function handleSync(request) {
  const authHeader = request.headers.get('authorization')
  const instance   = await authenticateInstance(authHeader)

  if (!instance) {
    return NextResponse.json(
      { error: { type: 'authentication_error', message: 'Invalid or missing sync token.' } },
      { status: 401 }
    )
  }

  const { searchParams } = new URL(request.url)
  const sinceVersion = parseInt(searchParams.get('since_version') ?? '0', 10)
  const instanceId   = searchParams.get('instance_id') ?? ''

  if (instanceId && instanceId !== instance.id) {
    return NextResponse.json(
      { error: { type: 'permission_error', message: 'instance_id does not match token.' } },
      { status: 403 }
    )
  }

  const client = await getDb().connect()
  let body
  try {
    body = await buildSyncResponse(client, {
      orgId:         instance.org_id,
      sinceVersion:  Number.isFinite(sinceVersion) ? sinceVersion : 0,
      syncIntervalS: SYNC_INTERVAL_S,
      decrypt:       decryptSecret,
    })
    client.release()
  } catch (err) {
    client.release(err) // drop the connection: it may be mid-transaction
    throw err
  }
  const currentVersion = body.current_version

  // Heartbeat async
  query(`
    UPDATE data_plane_instances
    SET last_seen_at = now(),
        last_version = $1
    WHERE id = $2
  `, [currentVersion, instance.id]).catch(err =>
    console.error('[sync] heartbeat update failed:', err)
  )

  return NextResponse.json(body)
}

// Authenticated by the instance's sync token, checked above.
export const GET = tokenRoute(handleSync)
