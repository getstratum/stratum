/**
 * The organization's identity provider (lib/sso.js, migration 034).
 *
 * GET    /api/sso → { provider: {...} | null, callbackUrl }
 * PUT    /api/sso  { kind: "google" | "oidc", issuer? (oidc), clientId,
 *                    clientSecret? (kept when omitted), domains: [...],
 *                    enforce?, enabled? } → the provider (Owner)
 * DELETE /api/sso → removed: everyone signs in with their password again
 *
 * Saving checks the provider's discovery document, so a typo in the
 * issuer shows here and not at the next sign-in.
 */
export const dynamic = 'force-dynamic'
import { route, readJson, json, badRequest } from '../../../lib/route.js'
import { audit } from '../../../lib/audit.js'
import { encryptSecret, secretHint, decryptSecret } from '../../../lib/secrets.js'
import { GOOGLE_ISSUER, callbackUrl, parseDomains, parseIssuer, providerConfig, refusedPublicDomains } from '../../../lib/sso.js'

const shape = (r) => r && ({
  kind: r.kind, issuer: r.issuer, clientId: r.client_id, clientSecretHint: secretHint(decryptSecret(r.client_secret_encrypted)),
  domains: r.domains, enforce: r.enforce, enabled: r.enabled, updatedAt: r.updated_at,
})

export const GET = route('sso.read', async (req, { session, db }) => {
  const { rows: [r] } = await db.query('SELECT * FROM sso_providers WHERE org_id = $1', [session.orgId])
  return json({ provider: shape(r) ?? null, callbackUrl: callbackUrl() })
})

export const PUT = route('sso.manage', async (req, { session, db }) => {
  if (!callbackUrl()) throw badRequest('Falta la dirección pública de la consola (STRATUM_CONSOLE_URL): el proveedor necesita a dónde volver.')
  const body = await readJson(req)
  const kind = body.kind
  if (!['google', 'oidc'].includes(kind)) throw badRequest('kind tiene que ser google u oidc.')
  const iss = kind === 'google' ? GOOGLE_ISSUER : parseIssuer(body.issuer)
  const clientId = typeof body.clientId === 'string' ? body.clientId.trim() : ''
  if (!clientId || clientId.length > 300) throw badRequest('Falta el client ID.')
  const domains = parseDomains(body.domains)
  const publicOnes = refusedPublicDomains(domains)
  if (publicOnes.length) {
    throw badRequest(`${publicOnes.join(', ')} es un correo público: cualquiera puede tener una dirección ahí, así que no identifica a la organización. Usá el dominio propio de la organización.`)
  }
  for (const k of ['enforce', 'enabled']) {
    if (body[k] !== undefined && typeof body[k] !== 'boolean') throw badRequest(`${k} tiene que ser true o false.`)
  }
  const { rows: [current] } = await db.query('SELECT * FROM sso_providers WHERE org_id = $1', [session.orgId])
  let secret = typeof body.clientSecret === 'string' ? body.clientSecret.trim() : ''
  if (!secret && !current) throw badRequest('Falta el client secret.')
  if (secret.length > 500) throw badRequest('El client secret es demasiado largo.')

  // A domain belongs to one organization's provider.
  const { rows: taken } = await db.query(
    'SELECT unnest(domains) AS d FROM sso_providers WHERE org_id <> $1', [session.orgId])
  const clash = domains.find(d => taken.some(t => t.d === d))
  if (clash) throw badRequest(`${clash} ya ingresa con el proveedor de otra organización.`)
  // Its people: whoever turns enforcement on must not lock everyone else out by a typo.
  const { rows: [{ n }] } = await db.query(
    `SELECT count(*)::int AS n FROM users WHERE org_id = $1 AND split_part(lower(email), '@', 2) = ANY($2)`,
    [session.orgId, domains])
  if (body.enforce && n === 0) throw badRequest('Ninguna persona de la organización tiene un mail de esos dominios.')

  try {
    await providerConfig(iss)
  } catch (err) {
    throw badRequest(`No se pudo leer la configuración del proveedor en ${iss}/.well-known/openid-configuration (${err.message}).`)
  }

  const enc = secret ? encryptSecret(secret) : current.client_secret_encrypted
  const { rows: [r] } = await db.query(
    `INSERT INTO sso_providers (org_id, kind, issuer, client_id, client_secret_encrypted, domains, enforce, enabled)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (org_id) DO UPDATE SET kind = EXCLUDED.kind, issuer = EXCLUDED.issuer, client_id = EXCLUDED.client_id,
       client_secret_encrypted = EXCLUDED.client_secret_encrypted, domains = EXCLUDED.domains,
       enforce = EXCLUDED.enforce, enabled = EXCLUDED.enabled, updated_at = now()
     RETURNING *`,
    [session.orgId, kind, iss, clientId, enc, domains, body.enforce ?? current?.enforce ?? false, body.enabled ?? current?.enabled ?? true])
  await audit(db, { req, session, action: 'sso.update', targetType: 'sso_provider', targetId: session.orgId,
    details: { kind, issuer: iss, domains, enforce: r.enforce, enabled: r.enabled, secretChanged: Boolean(secret), people: n } })
  secret = ''
  return json({ provider: shape(r), callbackUrl: callbackUrl() })
})

export const DELETE = route('sso.manage', async (req, { session, db }) => {
  const { rowCount } = await db.query('DELETE FROM sso_providers WHERE org_id = $1', [session.orgId])
  if (rowCount) await audit(db, { req, session, action: 'sso.delete', targetType: 'sso_provider', targetId: session.orgId })
  return json({ ok: true })
})
