// POST /api/sso/start  { email, i? } → { redirect }: a sign-in with the
// organization's identity provider (lib/sso.js), to the console or, with
// i, to an application (lib/oidc.js). Sets the browser half of the state.
export const dynamic = 'force-dynamic'
import { NextResponse } from 'next/server'
import { getDb } from '../../../../lib/db.js'
import { publicRoute, readJson, json, notFound } from '../../../../lib/route.js'
import { cookieOptions } from '../../../../lib/session.js'
import { loadInteraction, EXPIRED } from '../../../../lib/oidc.js'
import { BROWSER_COOKIE, LOGIN_MINUTES, SsoError, providerFor, startSso } from '../../../../lib/sso.js'

export const POST = publicRoute(async (req) => {
  const db = getDb()
  const body = await readJson(req)
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase().slice(0, 254) : ''
  let interaction = null
  if (body.i !== undefined) {
    const i = await loadInteraction(db, body.i)
    if (!i) throw notFound(EXPIRED)
    // The application's organization must be the one of that domain.
    const p = await providerFor(db, email)
    if (p && p.org_id !== String(i.org_id)) {
      return json({ error: 'no_sso', message: 'Ese dominio no ingresa con SSO a esta organización.' }, 400)
    }
    interaction = body.i
  }
  try {
    const { redirect, browser } = await startSso(db, { email, interaction })
    const res = NextResponse.json({ redirect })
    res.cookies.set(BROWSER_COOKIE, browser, { ...cookieOptions(), path: '/api/sso', maxAge: LOGIN_MINUTES * 60 })
    return res
  } catch (err) {
    if (!(err instanceof SsoError)) throw err
    if (err.code === 'no_provider') {
      return json({ error: 'no_sso', message: 'Tu organización no tiene ingreso con SSO para ese dominio. Entrá con tu contraseña.' }, 400)
    }
    console.error(`[sso] cannot start a sign-in: ${err.message}`)
    return json({ error: 'sso_unavailable', message: 'El proveedor de identidad de tu organización no responde. Probá de nuevo en un rato.' }, 502)
  }
})
