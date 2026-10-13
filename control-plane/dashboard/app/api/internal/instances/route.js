/**
 * Data Plane Instance management
 *
 * POST   /api/internal/instances         — registrar una nueva instancia del DP
 * GET    /api/internal/instances         — listar instancias de la org
 * DELETE /api/internal/instances?id=...  — revocar instancia
 *
 * Autenticación: sesión JWT del dashboard (cookie stratum_session).
 * NO usa sync_token — el sync_token lo genera el CP aquí.
 */

import { NextResponse }              from 'next/server'
import { createHash, randomBytes }   from 'crypto'
import { query }                     from '@/lib/db'
import { requireAuth }               from '@/lib/auth'

export const dynamic = 'force-dynamic'

// ---------------------------------------------------------------------------
// POST — registrar una instancia nueva
// ---------------------------------------------------------------------------

export async function POST(request) {
  const user = await requireAuth(request)
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let body
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const { label } = body
  const name = label ?? body.name   // accept both 'label' and 'name'

  if (!name || typeof name !== 'string' || name.trim().length === 0) {
    return NextResponse.json({ error: 'label (or name) is required' }, { status: 400 })
  }

  // Generar sync token (256 bits de entropía — nunca almacenado en claro)
  const rawToken   = `dp_sync_${randomBytes(32).toString('hex')}`
  const tokenHash  = createHash('sha256').update(rawToken).digest('hex')
  const instanceId = `dp_${randomBytes(16).toString('hex')}`

  await query(
    `INSERT INTO data_plane_instances (id, org_id, name, sync_token_hash)
     VALUES ($1, $2, $3, $4)`,
    [instanceId, user.org_id, name.trim(), tokenHash]
  )

  // Devolver el raw token SOLO en esta respuesta
  return NextResponse.json(
    {
      id:         instanceId,
      sync_token: rawToken,   // ← guardar ahora, no se puede ver después
      warning:    'Store this token securely. It will NOT be shown again.',
      name:       name.trim(),
    },
    { status: 201 }
  )
}

// ---------------------------------------------------------------------------
// GET — listar instancias de la org
// ---------------------------------------------------------------------------

export async function GET(request) {
  const user = await requireAuth(request)
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const instances = await query(
    `SELECT
       id,
       name,
       created_at,
       last_seen_at,
       last_version,
       disabled,
       EXTRACT(EPOCH FROM (now() - last_seen_at))::INT AS seconds_since_sync,
       CASE
         WHEN last_seen_at > now() - INTERVAL '2 minutes'  THEN 'online'
         WHEN last_seen_at > now() - INTERVAL '10 minutes' THEN 'stale'
         ELSE 'offline'
       END AS status
     FROM data_plane_instances
     WHERE org_id = $1
     ORDER BY created_at DESC`,
    [user.org_id]
  )

  return NextResponse.json({ instances })
}

// ---------------------------------------------------------------------------
// DELETE — revocar instancia
// ---------------------------------------------------------------------------

export async function DELETE(request) {
  const user = await requireAuth(request)
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { searchParams } = new URL(request.url)
  const instanceId = searchParams.get('id')
  if (!instanceId) {
    return NextResponse.json({ error: 'id is required' }, { status: 400 })
  }

  const result = await query(
    `UPDATE data_plane_instances
     SET disabled = true
     WHERE id = $1 AND org_id = $2
     RETURNING id`,
    [instanceId, user.org_id]
  )

  if (result.length === 0) {
    return NextResponse.json({ error: 'Instance not found' }, { status: 404 })
  }

  return NextResponse.json({ disabled: instanceId })
}
