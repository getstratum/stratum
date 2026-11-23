/**
 * Invitations from the console (ADR-0020, migration 049).
 *
 * GET  /api/invitations  — the open ones (a team manager: their team's)
 * POST /api/invitations  { email, role?, teamId? } — invites someone: a link
 *      that works once, for 72 hours, where they choose their password. The
 *      same roles and teams as adding them directly (POST /api/users). Sent
 *      by email when the console has SMTP; the link is in the answer either
 *      way, to pass on another way. Not for service tokens: they provision
 *      people directly, without passwords.
 */
export const dynamic = 'force-dynamic'
import { route, readJson, json, badRequest, forbidden, assertTeamInScope } from '@/lib/route'
import { assignableRoles } from '@/lib/authz'
import { audit } from '@/lib/audit'
import { createInvitation, sendInvitation, openInvitations, baseUrl, linkFor } from '@/lib/invitations'
import { withClient } from '@/lib/platform'

export const GET = route('users.read', async (req, { session, db }) =>
  json(await openInvitations(db, session.orgId, session.scope === 'team' ? session.teamId : null)))

export const POST = route('users.manage', async (req, { session, db }) => {
  const body = await readJson(req)
  const role = body.role ?? 'member'
  const teamId = body.teamId || (session.scope === 'team' ? session.teamId : null)
  if (!assignableRoles(session.role).includes(role)) throw forbidden('Tu rol no puede asignar ese rol.')
  await assertTeamInScope(db, session, teamId)
  if (role === 'team_manager' && !teamId) throw badRequest('Un gestor de equipo necesita un equipo.')

  const inv = await withClient(db, c => createInvitation(c, {
    orgId: session.orgId, email: body.email, role, teamId, invitedBy: session.email,
  }))
  const link = linkFor(baseUrl(req), inv.raw)
  const delivery = await sendInvitation(inv, link)
  await audit(db, {
    req, session, action: 'invitation.create', targetType: 'invitation', targetId: inv.id,
    details: { email: inv.email, role, teamId, sent: delivery.sent },
  })
  return json({
    invitation: { id: inv.id, email: inv.email, role, team_id: teamId, expires_at: inv.expiresAt },
    link, sent: delivery.sent, ...(delivery.sent ? {} : { reason: delivery.reason }),
  }, 201)
}, { serviceTokens: false })
