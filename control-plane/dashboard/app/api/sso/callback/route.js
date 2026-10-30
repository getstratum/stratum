// GET /api/sso/callback?code&state — back from the organization's identity
// provider (lib/sso.js). For the console: a session, then the console. For
// an application: its sign-in ends with a code, and the browser goes back
// to it. Any refusal goes back to the sign-in page with ?sso=<reason>;
// the details are in the audit log.
export const dynamic = 'force-dynamic'
import { NextResponse } from 'next/server'
import { getDb } from '../../../../lib/db.js'
import { publicRoute } from '../../../../lib/route.js'
import { COOKIE, createSession, cookieOptions } from '../../../../lib/session.js'
import { CONSOLE_ROLES } from '../../../../lib/authz.js'
import { audit, clientIp } from '../../../../lib/audit.js'
import { appUser, finishInteraction, issuer, loadInteraction } from '../../../../lib/oidc.js'
import { AMR, BROWSER_COOKIE, SsoError, finishSso } from '../../../../lib/sso.js'

// What the sign-in page says, by reason (the page has the words).
const SHOWN = {
  expired: 'expired', provider_error: 'provider', token_refused: 'provider', bad_token: 'provider',
  no_email: 'account', unverified_email: 'account', other_domain: 'account', not_workspace: 'account',
  unknown_user: 'account', no_console: 'no_console', no_app_access: 'account',
}

export const GET = publicRoute(async (req) => {
  const db = getDb()
  const base = issuer() ?? new URL(req.url).origin
  const q = new URL(req.url).searchParams
  const browser = req.cookies.get(BROWSER_COOKIE)?.value

  const back = (login, reason) => {
    const to = login?.interaction
      ? `${base}/oidc/login?i=${encodeURIComponent(login.interaction)}&sso=${SHOWN[reason] ?? 'provider'}`
      : `${base}/login?sso=${SHOWN[reason] ?? 'provider'}`
    const res = NextResponse.redirect(to, 303)
    res.cookies.set(BROWSER_COOKIE, '', { ...cookieOptions(), path: '/api/sso', maxAge: 0 })
    return res
  }
  const failed = async (login, reason, detail, email) => {
    await audit(db, {
      req, orgId: login?.org_id ?? null, actor: email ?? login?.login_hint ?? null,
      action: login?.interaction ? 'app.login' : 'session.login', result: 'failed',
      details: { method: 'sso', reason, detail: detail?.slice(0, 200) },
    })
    return back(login, reason)
  }

  let out
  try {
    out = await finishSso(db, { state: q.get('state'), code: q.get('code'), error: q.get('error'), browser })
  } catch (err) {
    if (!(err instanceof SsoError)) {
      console.error(`[sso] sign-in failed: ${err.message}`)
      return failed(err.login, 'provider_error', err.message)
    }
    return failed(err.login, err.code, err.message, err.email)
  }
  const { user, login } = out

  // An application's sign-in.
  if (login.interaction) {
    const interaction = await loadInteraction(db, login.interaction)
    if (!interaction) return failed(login, 'expired', 'the application sign-in expired', user.email)
    if (String(interaction.org_id) !== user.org_id || !await appUser(db, user.id, user.org_id)) {
      return failed(login, 'no_app_access', 'no access to applications', user.email)
    }
    const redirect = await finishInteraction(db, interaction, user.id, AMR)
    if (!redirect) return failed(login, 'expired', 'the application sign-in expired', user.email)
    await audit(db, {
      req, orgId: user.org_id, actor: user.email, action: 'app.login',
      targetType: 'oidc_client', targetId: interaction.client_id, details: { amr: AMR, method: 'sso' },
    })
    const res = NextResponse.redirect(redirect, 303)
    res.cookies.set(BROWSER_COOKIE, '', { ...cookieOptions(), path: '/api/sso', maxAge: 0 })
    return res
  }

  // The console: only its roles. The provider's second factor counts.
  if (!CONSOLE_ROLES.includes(user.role)) return failed(login, 'no_console', 'role without console', user.email)
  const token = await createSession(db, {
    userId: user.id, orgId: user.org_id, ip: clientIp(req), userAgent: req.headers.get('user-agent'),
  })
  await audit(db, {
    req, session: { orgId: user.org_id, userId: user.id, email: user.email, role: user.role },
    action: 'session.login', details: { method: 'sso', amr: AMR },
  })
  const res = NextResponse.redirect(`${base}/`, 303)
  res.cookies.set(COOKIE, token, cookieOptions())
  res.cookies.set(BROWSER_COOKIE, '', { ...cookieOptions(), path: '/api/sso', maxAge: 0 })
  return res
})
