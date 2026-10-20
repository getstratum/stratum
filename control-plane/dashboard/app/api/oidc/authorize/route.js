// GET /api/oidc/authorize — the start of a sign-in to an application
// (authorization code with PKCE). A valid request becomes an interaction
// and the browser goes to the sign-in page.
export const dynamic = 'force-dynamic'
import { NextResponse } from 'next/server'
import { getDb } from '../../../../lib/db.js'
import { publicRoute } from '../../../../lib/route.js'
import { issuer, checkAuthorize, createInteraction } from '../../../../lib/oidc.js'

const page = (iss, path) => NextResponse.redirect(`${iss}${path}`, 302)

export const GET = publicRoute(async (req) => {
  const iss = issuer()
  if (!iss) return new NextResponse('OIDC is off: set STRATUM_CONSOLE_URL.', { status: 404 })
  const db = getDb()
  const r = await checkAuthorize(db, new URL(req.url).searchParams)
  if (r.fatal) return page(iss, `/oidc/login?error=${r.fatal}`)
  if (r.redirect) return NextResponse.redirect(r.redirect, 302)
  const id = await createInteraction(db, r.client.id, r.params)
  return page(iss, `/oidc/login?i=${encodeURIComponent(id)}`)
})
