/**
 * Applications that sign people in with their console account (OIDC,
 * lib/oidc.js).
 *
 * GET  /api/apps → the organization's applications, and the issuer
 * POST /api/apps  { name, redirectUris: [...], requireMfa? } → a new one;
 *      its client secret is in the answer, this once
 */
export const dynamic = 'force-dynamic'
import { route, readJson, json, badRequest } from '../../../lib/route.js'
import { audit } from '../../../lib/audit.js'
import { issuer, newClientId, newClientSecret, CLIENT_COLUMNS as COLUMNS, parseRedirectUris, parseAppName } from '../../../lib/oidc.js'

export const GET = route('apps.read', async (req, { session, db }) => {
  const { rows } = await db.query(
    `SELECT ${COLUMNS} FROM oidc_clients c WHERE c.org_id = $1 ORDER BY c.revoked_at NULLS FIRST, c.created_at DESC`,
    [session.orgId])
  const iss = issuer()
  return json({ issuer: iss, discovery: iss ? `${iss}/.well-known/openid-configuration` : null, apps: rows })
})

export const POST = route('apps.manage', async (req, { session, db }) => {
  const body = await readJson(req)
  const name = parseAppName(body.name)
  const uris = parseRedirectUris(body.redirectUris)
  if (body.requireMfa !== undefined && typeof body.requireMfa !== 'boolean') throw badRequest('requireMfa tiene que ser true o false.')
  const id = newClientId()
  const secret = newClientSecret()
  const { rows: [app] } = await db.query(
    `INSERT INTO oidc_clients (id, org_id, name, secret_hash, redirect_uris, require_mfa)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING ${COLUMNS.replaceAll('c.', '')}`,
    [id, session.orgId, name, secret.hash, uris, body.requireMfa ?? true])
  await audit(db, { req, session, action: 'app.create', targetType: 'oidc_client', targetId: id,
    details: { name, redirectUris: uris, requireMfa: app.require_mfa } })
  return json({ app, clientSecret: secret.raw }, 201)
})
