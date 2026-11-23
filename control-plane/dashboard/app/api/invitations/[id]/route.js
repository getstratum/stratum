/**
 * DELETE /api/invitations/:id — revokes an open invitation: its link stops
 * working at once. A team manager only reaches their team's.
 */
export const dynamic = 'force-dynamic'
import { route, json, idParam, notFound } from '@/lib/route'
import { audit } from '@/lib/audit'

export const DELETE = route('users.manage', async (req, { session, db, params }) => {
  const id = idParam(params)
  const team = session.scope === 'team'
  const { rows: [inv] } = await db.query(
    `UPDATE invitations SET revoked_at = now()
      WHERE id = $1 AND org_id = $2 AND accepted_at IS NULL AND revoked_at IS NULL
        ${team ? 'AND team_id = $3' : ''}
      RETURNING id, email, role`,
    team ? [id, session.orgId, session.teamId] : [id, session.orgId])
  if (!inv) throw notFound('Invitación no encontrada.')
  await audit(db, { req, session, action: 'invitation.revoke', targetType: 'invitation', targetId: inv.id, details: { email: inv.email, role: inv.role } })
  return json({ revoked: inv.id })
}, { serviceTokens: false })
