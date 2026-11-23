// GET /api/oidc/entitlements — what the organization's plan includes, for
// an application of the organization (client_id and secret, HTTP Basic):
// the Enterprise portal and guard turn their functions on by it (ADR-0020,
// migration 050).
//
//   { org_id, plan, features, portal_seats }
//
// features null: not managed, whatever the installation's license includes.
// portal_seats null: the license's seats. The installation's signed license
// stays the ceiling; this only splits it among organizations.
export const dynamic = 'force-dynamic'
import { NextResponse } from 'next/server'
import { getDb } from '../../../../lib/db.js'
import { publicRoute } from '../../../../lib/route.js'
import { issuer, authenticateClient, clientCredentials } from '../../../../lib/oidc.js'
import { loadLimits } from '../../../../lib/org-limits.js'

const NO_STORE = { 'Cache-Control': 'no-store' }

export const GET = publicRoute(async (req) => {
  if (!issuer()) return NextResponse.json({ error: 'not_found', message: 'OIDC is off' }, { status: 404, headers: NO_STORE })
  const db = getDb()
  const creds = clientCredentials(req, new URLSearchParams())
  const c = await authenticateClient(db, creds.id, creds.secret)
  if (!c) {
    const res = NextResponse.json({ error: 'invalid_client', message: 'unknown client or wrong secret' }, { status: 401, headers: NO_STORE })
    res.headers.set('WWW-Authenticate', 'Basic realm="stratum"')
    return res
  }
  const { plan, limits, features } = await loadLimits(db, c.org_id)
  return NextResponse.json({
    org_id: c.org_id, plan, features, portal_seats: limits.portal_seats ?? null,
  }, { headers: NO_STORE })
})
