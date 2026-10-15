/**
 * Data plane instances (gateways) of the session's organization.
 *
 * POST   /api/internal/instances         — register one; returns its sync token once
 * GET    /api/internal/instances         — list them
 * PATCH  /api/internal/instances?id=...  { action: 'rotate-token' } — new sync token, shown once
 * DELETE /api/internal/instances?id=...  — disable one (its token stops working)
 *
 * Console session routes (lib/route.js). The sync token is generated here and
 * only its SHA-256 is stored.
 */

import { createHash, randomBytes } from 'crypto'
import { route, readJson, json, badRequest, notFound } from '@/lib/route'
import { audit } from '@/lib/audit'

export const dynamic = 'force-dynamic'

export const POST = route('gateways.manage', async (req, { session, db }) => {
  const body = await readJson(req)
  const name = body.label ?? body.name // 'label' and 'name' are both accepted
  if (typeof name !== 'string' || !name.trim()) throw badRequest('label (o name) es obligatorio.')

  const rawToken   = `dp_sync_${randomBytes(32).toString('hex')}`
  const tokenHash  = createHash('sha256').update(rawToken).digest('hex')
  const instanceId = `dp_${randomBytes(16).toString('hex')}`

  await db.query(
    `INSERT INTO data_plane_instances (id, org_id, name, sync_token_hash) VALUES ($1, $2, $3, $4)`,
    [instanceId, session.orgId, name.trim().slice(0, 255), tokenHash])
  await audit(db, { req, session, action: 'gateway.register', targetType: 'gateway', targetId: instanceId, details: { name: name.trim() } })

  return json({
    id:         instanceId,
    sync_token: rawToken,
    warning:    'Store this token securely. It will NOT be shown again.',
    name:       name.trim(),
  }, 201)
})

export const GET = route('gateways.read', async (req, { session, db }) => {
  const [{ rows }, { rows: [v] }] = await Promise.all([
    db.query(
      `SELECT id, name, created_at, last_seen_at, last_version, disabled,
              EXTRACT(EPOCH FROM (now() - last_seen_at))::INT AS seconds_since_sync,
              CASE
                WHEN disabled                                     THEN 'disabled'
                WHEN last_seen_at IS NULL                         THEN 'never'
                WHEN last_seen_at > now() - INTERVAL '2 minutes'  THEN 'online'
                WHEN last_seen_at > now() - INTERVAL '10 minutes' THEN 'stale'
                ELSE 'offline'
              END AS status
         FROM data_plane_instances
        WHERE org_id = $1
        ORDER BY disabled, created_at DESC`,
      [session.orgId]),
    db.query('SELECT stratum_sync_version($1)::bigint AS v', [session.orgId]),
  ])
  // current_version: the configuration version gateways should be on.
  return json({ instances: rows, current_version: Number(v.v) })
})

export const PATCH = route('gateways.manage', async (req, { session, db }) => {
  const instanceId = new URL(req.url).searchParams.get('id')
  if (!instanceId) throw badRequest('id es obligatorio.')
  const { action } = await readJson(req)
  if (action !== 'rotate-token') throw badRequest('Acción desconocida.')
  const rawToken  = `dp_sync_${randomBytes(32).toString('hex')}`
  const tokenHash = createHash('sha256').update(rawToken).digest('hex')
  const { rows } = await db.query(
    `UPDATE data_plane_instances SET sync_token_hash = $3
      WHERE id = $1 AND org_id = $2 AND NOT disabled
      RETURNING id, name`,
    [instanceId, session.orgId, tokenHash])
  if (!rows[0]) throw notFound('Instancia no encontrada.')
  await audit(db, { req, session, action: 'gateway.token.rotate', targetType: 'gateway', targetId: instanceId, details: { name: rows[0].name } })
  return json({ id: instanceId, name: rows[0].name, sync_token: rawToken, warning: 'Store this token securely. It will NOT be shown again.' })
})

export const DELETE = route('gateways.manage', async (req, { session, db }) => {
  const instanceId = new URL(req.url).searchParams.get('id')
  if (!instanceId) throw badRequest('id es obligatorio.')
  const { rows } = await db.query(
    `UPDATE data_plane_instances SET disabled = true WHERE id = $1 AND org_id = $2 RETURNING id, name`,
    [instanceId, session.orgId])
  if (!rows[0]) throw notFound('Instancia no encontrada.')
  await audit(db, { req, session, action: 'gateway.disable', targetType: 'gateway', targetId: instanceId, details: { name: rows[0].name } })
  return json({ disabled: instanceId })
})
