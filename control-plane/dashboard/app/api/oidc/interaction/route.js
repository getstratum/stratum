// GET /api/oidc/interaction?i=... — what the sign-in page shows: which
// application and organization the person is signing in to.
export const dynamic = 'force-dynamic'
import { getDb } from '../../../../lib/db.js'
import { publicRoute, json, notFound } from '../../../../lib/route.js'
import { loadInteraction, EXPIRED } from '../../../../lib/oidc.js'

export const GET = publicRoute(async (req) => {
  const i = await loadInteraction(getDb(), new URL(req.url).searchParams.get('i'))
  if (!i) throw notFound(EXPIRED)
  return json({ client: i.client_name, org: i.org_name })
})
