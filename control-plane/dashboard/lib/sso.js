/**
 * lib/sso.js — signing in with the organization's own identity provider
 * (migration 034): the console as an OpenID Connect client of Google
 * Workspace, Microsoft Entra ID, Okta or any other provider.
 *
 * The person types their email; its domain picks the organization's
 * provider. Authorization code flow with PKCE (S256), a nonce, and a state
 * bound to the browser (a cookie holds half of it). The ID token's
 * signature is checked against the provider's keys (JWKS, RS256 or
 * ES256), and its issuer, audience, expiry and nonce.
 *
 * Who gets in: someone already in Users, in that organization, whose email
 * the provider says is theirs (email_verified) and is in one of its
 * domains; with Google, a Workspace account of that domain (the hd claim),
 * never a personal one with the same address. Nobody is created here.
 *
 * The second factor is the provider's: a sign-in this way counts as one
 * with two factors (amr "fed"), for the console's Owners and Admins and for
 * applications that ask for them. The organization makes its provider
 * require them (Google Workspace: 2-Step Verification enforced).
 */

import { createHash, createPublicKey, randomBytes, verify } from 'node:crypto'
import { badRequest } from './route.js'
import { decryptSecret } from './secrets.js'
import { issuer as consoleIssuer } from './oidc.js'

export const GOOGLE_ISSUER = 'https://accounts.google.com'
export const LOGIN_MINUTES = 10
export const BROWSER_COOKIE = 'stratum_sso'
export const AMR = ['fed']

const sha256 = (v) => createHash('sha256').update(v).digest('hex')
const b64url = (buf) => Buffer.from(buf).toString('base64url')

export class SsoError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

/** The address the provider sends people back to (register it there). */
export const callbackUrl = (env = process.env) => {
  const iss = consoleIssuer(env)
  return iss ? `${iss}/api/sso/callback` : null
}

const isLoopback = (h) => h === 'localhost' || h === '127.0.0.1' || h === '[::1]'

/** https, or http on this machine (tests); no query or fragment. */
export function parseIssuer(value) {
  const v = typeof value === 'string' ? value.trim().replace(/\/+$/, '') : ''
  try {
    const u = new URL(v)
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && isLoopback(u.hostname))) throw new Error()
    if (u.search || u.hash || u.username) throw new Error()
    return v
  } catch {
    throw badRequest('El emisor tiene que ser una dirección https, sin parámetros.')
  }
}

const DOMAIN_RE = /^(?=.{3,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/

export function parseDomains(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 20) {
    throw badRequest('Tiene que haber entre uno y veinte dominios.')
  }
  const out = [...new Set(value.map(d => (typeof d === 'string' ? d.trim().toLowerCase().replace(/^@/, '') : '')))]
  for (const d of out) if (!DOMAIN_RE.test(d)) throw badRequest(`"${d}" no es un dominio.`)
  return out
}

/**
 * Domains of public email services: anyone can have an address there, so
 * none of them identifies an organization. Refused as an SSO domain, except
 * on a console that runs on this machine (a demo, or a test with a
 * personal account).
 */
export const PUBLIC_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'yahoo.com', 'yahoo.com.ar',
  'ymail.com', 'icloud.com', 'me.com', 'mac.com', 'aol.com', 'proton.me', 'protonmail.com', 'pm.me', 'gmx.com',
  'gmx.net', 'mail.com', 'zoho.com', 'yandex.com', 'yandex.ru', 'hey.com', 'fastmail.com', 'tutanota.com', 'qq.com',
  '163.com', 'hotmail.es', 'outlook.es', 'hotmail.com.ar', 'live.com.ar', 'yahoo.es', 'yahoo.com.mx', 'hotmail.com.mx',
])

/** Whether the console runs on this machine (its public address is localhost). */
export function consoleIsLocal(env = process.env) {
  const iss = consoleIssuer(env)
  if (!iss) return false
  return isLoopback(new URL(iss).hostname)
}

/** The public email domains among `domains` that this console refuses. */
export function refusedPublicDomains(domains, env = process.env) {
  return consoleIsLocal(env) ? [] : domains.filter(d => PUBLIC_DOMAINS.has(d))
}

export const domainOf = (email) => {
  const at = String(email ?? '').lastIndexOf('@')
  return at > 0 ? String(email).slice(at + 1).trim().toLowerCase() : ''
}

/** The enabled provider for an email's domain, or null. */
export async function providerFor(db, email) {
  const domain = domainOf(email)
  if (!domain) return null
  const { rows: [p] } = await db.query(
    `SELECT s.org_id::text AS org_id, s.kind, s.issuer, s.client_id, s.client_secret_encrypted, s.domains, s.enforce
       FROM sso_providers s JOIN organizations o ON o.id = s.org_id
      WHERE s.enabled AND o.status = 'active' AND $1 = ANY(s.domains)
      LIMIT 1`, [domain])
  return p ?? null
}

/** Whether the password is refused for this person: their domain's provider enforces SSO and they are not an Owner. */
export async function passwordRefused(db, { email, orgId, role }) {
  if (role === 'owner') return false
  const p = await providerFor(db, email)
  return Boolean(p && p.enforce && p.org_id === String(orgId))
}

// ── The provider's discovery document and keys, cached ───────────────────

const CACHE_MS = 60 * 60 * 1000
const S = (globalThis.__stratumSso ??= { discovery: new Map(), jwks: new Map() })

async function getJson(url, fetchImpl) {
  const res = await fetchImpl(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(10_000) })
  if (!res.ok) throw new SsoError('provider_unreachable', `${url}: ${res.status}`)
  return res.json()
}

export async function providerConfig(iss, fetchImpl = fetch) {
  const hit = S.discovery.get(iss)
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.doc
  const doc = await getJson(`${iss}/.well-known/openid-configuration`, fetchImpl)
  if (doc.issuer !== iss) throw new SsoError('provider_mismatch', `the discovery document says its issuer is ${doc.issuer}`)
  for (const k of ['authorization_endpoint', 'token_endpoint', 'jwks_uri']) {
    if (typeof doc[k] !== 'string') throw new SsoError('provider_mismatch', `the discovery document has no ${k}`)
  }
  S.discovery.set(iss, { at: Date.now(), doc })
  return doc
}

async function keysOf(jwksUri, fetchImpl, fresh = false) {
  const hit = S.jwks.get(jwksUri)
  if (!fresh && hit && Date.now() - hit.at < CACHE_MS) return hit.keys
  const { keys } = await getJson(jwksUri, fetchImpl)
  S.jwks.set(jwksUri, { at: Date.now(), keys: Array.isArray(keys) ? keys : [] })
  return S.jwks.get(jwksUri).keys
}

/** For tests: forget what was fetched. */
export function resetSsoCache() { S.discovery.clear(); S.jwks.clear() }

const ALGS = { RS256: 'RSA-SHA256', ES256: 'SHA256' }

/**
 * The claims of a provider's ID token, checked; throws SsoError otherwise.
 * A key the cached set does not have is looked up again once (the
 * provider rotated its keys).
 */
export async function verifyIdToken(token, { iss, clientId, nonce, jwksUri, now = Date.now(), fetchImpl = fetch }) {
  const parts = typeof token === 'string' ? token.split('.') : []
  if (parts.length !== 3 || token.length > 16_384) throw new SsoError('bad_token', 'not a JWT')
  let header, claims
  try {
    header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'))
    claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
  } catch {
    throw new SsoError('bad_token', 'unreadable JWT')
  }
  const alg = ALGS[header.alg]
  if (!alg) throw new SsoError('bad_token', `algorithm ${header.alg} not accepted`)
  let jwk = (await keysOf(jwksUri, fetchImpl)).find(k => k.kid === header.kid)
  if (!jwk) jwk = (await keysOf(jwksUri, fetchImpl, true)).find(k => k.kid === header.kid)
  if (!jwk) throw new SsoError('bad_token', `unknown key ${header.kid}`)
  const key = createPublicKey({ key: jwk, format: 'jwk' })
  const signed = Buffer.from(`${parts[0]}.${parts[1]}`)
  const sig = Buffer.from(parts[2], 'base64url')
  const ok = header.alg === 'ES256'
    ? verify(alg, signed, { key, dsaEncoding: 'ieee-p1363' }, sig)
    : verify(alg, signed, key, sig)
  if (!ok) throw new SsoError('bad_token', 'bad signature')
  const t = Math.floor(now / 1000)
  if (claims.iss !== iss) throw new SsoError('bad_token', 'wrong issuer')
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud]
  if (!aud.includes(clientId)) throw new SsoError('bad_token', 'wrong audience')
  if (aud.length > 1 && claims.azp !== clientId) throw new SsoError('bad_token', 'wrong authorized party')
  if (typeof claims.exp !== 'number' || claims.exp + 60 < t) throw new SsoError('bad_token', 'expired')
  if (typeof claims.iat === 'number' && claims.iat - 60 > t) throw new SsoError('bad_token', 'issued in the future')
  if (claims.nonce !== nonce) throw new SsoError('bad_token', 'wrong nonce')
  return claims
}

/**
 * Which email the claims prove, for this provider, or throws: verified, in
 * one of its domains, and with Google a Workspace account of that domain.
 */
export function provenEmail(claims, provider) {
  const email = typeof claims.email === 'string' ? claims.email.trim().toLowerCase() : ''
  if (!email) throw new SsoError('no_email', 'the provider gave no email (scope email)')
  if (claims.email_verified !== true && claims.email_verified !== 'true') throw new SsoError('unverified_email', 'email not verified')
  const domain = domainOf(email)
  if (!provider.domains.includes(domain)) throw new SsoError('other_domain', `${domain} is not one of the provider's domains`)
  if (provider.kind === 'google' && claims.hd !== domain) {
    throw new SsoError('not_workspace', 'not a Google Workspace account of that domain')
  }
  return email
}

// ── The sign-in ──────────────────────────────────────────────────────────

/**
 * Starts a sign-in for `email`: { redirect, browser } (browser: the cookie
 * value to set), or throws SsoError no_provider. interaction: an
 * application's sign-in in progress, to finish when the person is back.
 */
export async function startSso(db, { email, interaction = null, fetchImpl = fetch }) {
  const p = await providerFor(db, email)
  if (!p) throw new SsoError('no_provider', 'no provider for that domain')
  const cb = callbackUrl()
  if (!cb) throw new SsoError('not_configured', 'STRATUM_CONSOLE_URL is not set')
  const doc = await providerConfig(p.issuer, fetchImpl)
  const state = b64url(randomBytes(32))
  const browser = b64url(randomBytes(32))
  const nonce = b64url(randomBytes(24))
  const verifier = b64url(randomBytes(48))
  await db.query('DELETE FROM sso_logins WHERE expires_at < now()')
  await db.query(
    `INSERT INTO sso_logins (state_hash, browser_hash, org_id, nonce, verifier, login_hint, interaction, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, now() + make_interval(mins => $8))`,
    [sha256(state), sha256(browser), p.org_id, nonce, verifier, email.trim().toLowerCase(), interaction, LOGIN_MINUTES])
  const u = new URL(doc.authorization_endpoint)
  const q = {
    response_type: 'code', client_id: p.client_id, redirect_uri: cb, scope: 'openid email profile',
    state, nonce, code_challenge: b64url(createHash('sha256').update(verifier).digest()), code_challenge_method: 'S256',
    login_hint: email.trim().toLowerCase(),
  }
  // Google: offer only accounts of the organization's domain.
  if (p.kind === 'google') q.hd = domainOf(email)
  for (const [k, v] of Object.entries(q)) u.searchParams.set(k, v)
  return { redirect: u.toString(), browser }
}

/**
 * The person is back from the provider: { user, login } where user is
 * { id, org_id, email, role, ... } and login.interaction is the
 * application's sign-in to finish (or null for the console). Throws
 * SsoError (codes: expired, provider_error, token_refused, bad_token,
 * no_email, unverified_email, other_domain, not_workspace, unknown_user).
 */
export async function finishSso(db, { state, code, error, browser, fetchImpl = fetch }) {
  if (typeof state !== 'string' || state.length > 200) throw new SsoError('expired', 'no state')
  const { rows: [login] } = await db.query(
    `DELETE FROM sso_logins WHERE state_hash = $1 RETURNING *, expires_at > now() AS live`, [sha256(state)])
  if (!login || !login.live) throw new SsoError('expired', 'unknown or expired state')
  if (typeof browser !== 'string' || sha256(browser) !== login.browser_hash) {
    throw new SsoError('expired', 'started in another browser')
  }
  const result = { login }
  if (error) throw Object.assign(new SsoError('provider_error', String(error).slice(0, 100)), result)
  if (typeof code !== 'string' || !code || code.length > 4096) throw Object.assign(new SsoError('provider_error', 'no code'), result)

  const { rows: [p] } = await db.query(
    `SELECT org_id::text AS org_id, kind, issuer, client_id, client_secret_encrypted, domains
       FROM sso_providers WHERE org_id = $1 AND enabled`, [login.org_id])
  if (!p) throw Object.assign(new SsoError('expired', 'the provider was turned off'), result)
  const doc = await providerConfig(p.issuer, fetchImpl)
  const res = await fetchImpl(doc.token_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({
      grant_type: 'authorization_code', code, redirect_uri: callbackUrl(), code_verifier: login.verifier,
      client_id: p.client_id, client_secret: decryptSecret(p.client_secret_encrypted),
    }),
    signal: AbortSignal.timeout(10_000),
  })
  const tokens = await res.json().catch(() => ({}))
  if (!res.ok || typeof tokens.id_token !== 'string') {
    throw Object.assign(new SsoError('token_refused', `${res.status} ${tokens.error ?? ''}`.trim()), result)
  }
  const claims = await verifyIdToken(tokens.id_token, {
    iss: p.issuer, clientId: p.client_id, nonce: login.nonce, jwksUri: doc.jwks_uri, fetchImpl,
  }).catch(err => { throw Object.assign(err, result) })
  let email
  try {
    email = provenEmail(claims, p)
  } catch (err) {
    throw Object.assign(err, result)
  }
  const { rows: [user] } = await db.query(
    `SELECT u.id::text AS id, u.org_id::text AS org_id, u.email, u.role, u.team_id::text AS team_id,
            COALESCE(u.is_active, true) AS is_active
       FROM users u WHERE u.org_id = $1 AND lower(u.email) = $2`, [p.org_id, email])
  if (!user || !user.is_active) throw Object.assign(new SsoError('unknown_user', email), result, { email })
  return { user, login, email }
}
