/**
 * POST /api/invitations/accept  { token, name?, password } — creates the
 * account with the password its person chose and spends the link (lib/
 * invitations.js). Someone who signs in to the console gets a session; an
 * Owner or Admin one that only sets up the second factor first, as on a
 * first sign-in. A member, who uses applications and not the console, gets
 * none. An organization that signs in with its identity provider takes no
 * password.
 */
export const dynamic = 'force-dynamic'
import { NextResponse } from 'next/server'
import { publicRoute, readJson } from '@/lib/route'
import { getDb } from '@/lib/db'
import { acceptInvitation } from '@/lib/invitations'
import { COOKIE, createSession, cookieOptions } from '@/lib/session'
import { CONSOLE_ROLES } from '@/lib/authz'
import { mfaRequired } from '@/lib/mfa'
import { audit, clientIp } from '@/lib/audit'

export const POST = publicRoute(async (req) => {
  const db = getDb()
  const body = await readJson(req)
  const u = await acceptInvitation(db, { raw: body.token, name: body.name, password: body.password })
  const session = { orgId: u.org_id, userId: u.id, email: u.email, role: u.role }
  await audit(db, {
    req, session, action: 'invitation.accept', targetType: 'invitation', targetId: u.invitationId,
    details: { email: u.email, role: u.role, teamId: u.team_id, sso: u.sso },
  })

  // With SSO, or without the console, there is nothing to sign in to here.
  if (u.sso || !CONSOLE_ROLES.includes(u.role)) {
    return NextResponse.json({ ok: true, next: u.sso ? '/login' : null, sso: u.sso, console: CONSOLE_ROLES.includes(u.role) })
  }
  const enrollmentOnly = mfaRequired(u.role)
  const token = await createSession(db, {
    userId: u.id, orgId: u.org_id, ip: clientIp(req), userAgent: req.headers.get('user-agent'), enrollmentOnly,
  })
  await audit(db, { req, session, action: 'session.login', details: { via: 'invitation', ...(enrollmentOnly ? { mfa: 'enrollment_required' } : {}) } })
  const res = NextResponse.json({ ok: true, next: enrollmentOnly ? '/account?mfa=required' : '/', sso: false, console: true })
  res.cookies.set(COOKIE, token, cookieOptions())
  return res
})
