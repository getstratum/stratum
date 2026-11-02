/**
 * DELETE /api/service-tokens/:id → revoked, at once (Owner).
 */
export const dynamic = 'force-dynamic'
import { route, json, notFound, isUuid } from '../../../../lib/route.js'
import { audit } from '../../../../lib/audit.js'

export const DELETE = route('tokens.manage', async (req, { session, db, params }) => {
  if (!isUuid(params.id)) throw notFound('Token no encontrado.')
  const { rows: [t] } = await db.query(
    `UPDATE service_tokens SET revoked_at = COALESCE(revoked_at, now())
      WHERE id = $1 AND org_id = $2 RETURNING id, name`, [params.id, session.orgId])
  if (!t) throw notFound('Token no encontrado.')
  await audit(db, { req, session, action: 'service_token.revoke', targetType: 'service_token', targetId: t.id, details: { name: t.name } })
  return json({ ok: true })
}, { serviceTokens: false })
