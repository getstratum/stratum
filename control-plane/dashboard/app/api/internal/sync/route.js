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
import { getDb } from '@/lib/db'
import { buildSyncResponse } from '@/lib/sync'
import { decryptSecret } from '@/lib/secrets'
import { authenticateInstance, recordSync } from '@/lib/instance-auth'

import { tokenRoute } from '@/lib/route'

export const dynamic = 'force-dynamic'

const SYNC_INTERVAL_S = parseInt(process.env.STRATUM_SYNC_INTERVAL_S ?? '30', 10)

async function handleSync(request) {
  const instance = await authenticateInstance(getDb(), request.headers.get('authorization'))

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

  // Heartbeat, off the response path.
  recordSync(getDb(), instance.id, currentVersion, request.headers.get('user-agent')).catch(err =>
    console.error('[sync] heartbeat update failed:', err)
  )

  return NextResponse.json(body)
}

// Authenticated by the instance's sync token, checked above.
export const GET = tokenRoute(handleSync)
