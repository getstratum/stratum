export const dynamic = 'force-dynamic'
import { route, json, badRequest } from '../../../../../lib/route.js'
import { loadManagedUser } from '../../../../../lib/users.js'
import { revokeUserSessions } from '../../../../../lib/session.js'
import { audit } from '../../../../../lib/audit.js'
import { disable } from '../../../../../lib/mfa.js'

// DELETE /api/users/:id/mfa → reset someone's second factor (lost phone).
// Their sessions end; an Owner or Admin has to set it up again on the next
// sign-in. For one's own, the account page; for a locked-out sole Owner,
// `stratum-admin reset-mfa`.
export const DELETE = route('users.manage', async (req, { session, db, params }) => {
  const target = await loadManagedUser(db, session, params.id)
  if (target.id === session.userId) throw badRequest('Para la tuya usá Mi cuenta.')
  await disable(db, target.id)
  await revokeUserSessions(db, target.id)
  await audit(db, { req, session, action: 'user.mfa.reset', targetType: 'user', targetId: target.id, details: { email: target.email } })
  return json({ ok: true })
})
