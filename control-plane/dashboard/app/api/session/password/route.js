export const dynamic = 'force-dynamic'
import { route, readJson, json, badRequest, forbidden } from '../../../../lib/route.js'
import { hashPassword, passwordProblem, verifyPassword } from '../../../../lib/password.js'
import { revokeUserSessions } from '../../../../lib/session.js'
import { audit } from '../../../../lib/audit.js'

// POST /api/session/password  { currentPassword, newPassword }
// The signed-in person changes their own password. Asking for the current one
// keeps a stolen session from locking the owner out; their other sessions end.
export const POST = route('org.read', async (req, { session, db }) => {
  const body = await readJson(req)
  const problem = passwordProblem(body.newPassword)
  if (problem) throw badRequest(problem)

  const { rows } = await db.query('SELECT password_hash FROM users WHERE id = $1 AND org_id = $2', [session.userId, session.orgId])
  if (!(await verifyPassword(body.currentPassword, rows[0]?.password_hash))) {
    await audit(db, { req, session, action: 'user.password.change', result: 'failed', targetType: 'user', targetId: session.userId })
    throw forbidden('La contraseña actual no es correcta.')
  }

  await db.query('UPDATE users SET password_hash = $2 WHERE id = $1', [session.userId, await hashPassword(body.newPassword)])
  await revokeUserSessions(db, session.userId, session.tokenHash)
  await audit(db, { req, session, action: 'user.password.change', targetType: 'user', targetId: session.userId })
  return json({ ok: true })
})
