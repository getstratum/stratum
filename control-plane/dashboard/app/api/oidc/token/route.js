// POST /api/oidc/token — an application redeems an authorization code
// (grant_type=authorization_code, with the PKCE verifier) for an ID token
// and an access token for userinfo. Errors follow RFC 6749 §5.2.
export const dynamic = 'force-dynamic'
import { NextResponse } from 'next/server'
import { getDb } from '../../../../lib/db.js'
import { publicRoute } from '../../../../lib/route.js'
import { issuer, authenticateClient, clientCredentials, redeemCode, appUser, issueTokens } from '../../../../lib/oidc.js'
import { audit } from '../../../../lib/audit.js'

const NO_STORE = { 'Cache-Control': 'no-store', Pragma: 'no-cache' }
const fail = (status, error, description) =>
  NextResponse.json({ error, error_description: description }, { status, headers: NO_STORE })

export const POST = publicRoute(async (req) => {
  if (!issuer()) return fail(404, 'invalid_request', 'OIDC is off')
  const type = req.headers.get('content-type') ?? ''
  if (!type.startsWith('application/x-www-form-urlencoded')) {
    return fail(400, 'invalid_request', 'the body must be application/x-www-form-urlencoded')
  }
  const form = new URLSearchParams(await req.text())
  const db = getDb()

  const creds = clientCredentials(req, form)
  const client = await authenticateClient(db, creds.id, creds.secret)
  if (!client) {
    const res = fail(401, 'invalid_client', 'unknown client or wrong secret')
    res.headers.set('WWW-Authenticate', 'Basic realm="stratum"')
    return res
  }
  if (form.get('grant_type') !== 'authorization_code') {
    return fail(400, 'unsupported_grant_type', 'only authorization_code')
  }
  const code = await redeemCode(db, {
    code: form.get('code'), client, redirectUri: form.get('redirect_uri'), verifier: form.get('code_verifier'),
  })
  if (!code) return fail(400, 'invalid_grant', 'the code is unknown, expired, used, or does not match')

  // The person may have lost access in the seconds since the sign-in.
  const user = await appUser(db, code.user_id, client.org_id)
  if (!user) return fail(400, 'invalid_grant', 'the person may no longer sign in to applications')

  const tokens = await issueTokens(db, { client, user, code })
  await audit(db, {
    req, orgId: client.org_id, actor: user.email, action: 'app.token',
    targetType: 'oidc_client', targetId: client.id,
  })
  return NextResponse.json(tokens, { headers: NO_STORE })
})
