/**
 * POST /api/invitations/lookup  { token } — what the invitation page shows
 * before someone accepts: organization, email, role, until when, and
 * whether the organization signs in with its identity provider. 410 when
 * the link does not work (used, expired, replaced or revoked: one answer
 * for all). POST so the token is in no URL.
 */
export const dynamic = 'force-dynamic'
import { publicRoute, readJson, json } from '@/lib/route'
import { getDb } from '@/lib/db'
import { lookupInvitation } from '@/lib/invitations'

export const POST = publicRoute(async (req) => {
  const { token } = await readJson(req)
  const inv = await lookupInvitation(getDb(), token)
  if (!inv) {
    return json({ error: 'invitation_invalid',
      message: 'La invitación no sirve: ya se usó, venció o la reemplazaron por otra. Pedile una nueva a quien te invitó.' }, 410)
  }
  return json(inv)
})
