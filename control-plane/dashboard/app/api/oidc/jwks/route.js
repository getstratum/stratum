// GET /api/oidc/jwks — the public keys that sign ID tokens.
export const dynamic = 'force-dynamic'
import { NextResponse } from 'next/server'
import { getDb } from '../../../../lib/db.js'
import { publicRoute } from '../../../../lib/route.js'
import { issuer, signingKey, publicKeys } from '../../../../lib/oidc.js'

export const GET = publicRoute(async () => {
  if (!issuer()) return NextResponse.json({ error: 'not_found' }, { status: 404 })
  const db = getDb()
  await signingKey(db) // the first one is made on first use
  return NextResponse.json({ keys: await publicKeys(db) }, { headers: { 'Cache-Control': 'public, max-age=300' } })
})
