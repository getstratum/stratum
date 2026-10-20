// GET /api/oidc/userinfo — the signed-in person, for an access token from
// /api/oidc/token. Refused once the person may no longer sign in.
export const dynamic = 'force-dynamic'
import { NextResponse } from 'next/server'
import { getDb } from '../../../../lib/db.js'
import { publicRoute } from '../../../../lib/route.js'
import { issuer, verifyJwt, appUser } from '../../../../lib/oidc.js'

const unauthorized = (error) => NextResponse.json({ error }, {
  status: 401, headers: { 'WWW-Authenticate': `Bearer error="${error}"`, 'Cache-Control': 'no-store' },
})

export const GET = publicRoute(async (req) => {
  const iss = issuer()
  if (!iss) return NextResponse.json({ error: 'not_found' }, { status: 404 })
  const h = req.headers.get('authorization') ?? ''
  const token = /^bearer /i.test(h) ? h.slice(7).trim() : ''
  const db = getDb()
  const claims = token ? await verifyJwt(db, token, { typ: 'at+jwt', aud: `${iss}/api/oidc/userinfo` }) : null
  if (!claims) return unauthorized('invalid_token')
  const { rows: [c] } = await db.query(
    'SELECT org_id::text AS org_id FROM oidc_clients WHERE id = $1 AND revoked_at IS NULL', [claims.client_id])
  const user = c ? await appUser(db, claims.sub, c.org_id) : null
  if (!user) return unauthorized('invalid_token')
  const scope = String(claims.scope ?? '').split(' ')
  return NextResponse.json({
    sub: user.id,
    ...(scope.includes('email') ? { email: user.email } : {}),
    ...(scope.includes('profile') ? { name: user.name || user.email } : {}),
    org_id: user.org_id,
    team_id: user.team_id,
  }, { headers: { 'Cache-Control': 'no-store' } })
})
