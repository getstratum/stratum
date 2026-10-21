// OpenID Connect discovery for the console as a provider (lib/oidc.js).
export const dynamic = 'force-dynamic'
import { publicRoute, json } from '../../../lib/route.js'
import { issuer, discovery } from '../../../lib/oidc.js'

export const GET = publicRoute(async () => {
  const iss = issuer()
  if (!iss) return json({ error: 'not_found', message: 'OIDC is off: set STRATUM_CONSOLE_URL.' }, 404)
  return json(discovery(iss))
})
