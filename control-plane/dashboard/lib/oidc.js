/**
 * lib/oidc.js — the console as an OpenID Connect provider (migration 030)
 * for the organization's own applications.
 *
 * Only what those applications need: the authorization code flow with PKCE
 * (S256), confidential clients (client_secret_basic or client_secret_post),
 * RS256 ID tokens, userinfo and JWKS. No implicit flow, no refresh tokens,
 * no dynamic registration: an Owner or Admin registers each application in
 * the console. Every sign-in asks for the password (and the second factor),
 * since the console keeps no single sign-on session for applications.
 *
 * The issuer is STRATUM_CONSOLE_URL, the console's public address; without
 * it the provider is off. Endpoints live under {issuer}/api/oidc/.
 *
 * Who may sign in to an application: an active person of the application's
 * organization, with a password, a team and access to applications
 * (users.app_access, migration 028). Their console role does not matter:
 * Members, who cannot use the console, sign in to applications too.
 */

import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, timingSafeEqual, verify } from 'node:crypto'
import { encryptSecret, decryptSecret } from './secrets.js'
import { badRequest } from './route.js'

export const INTERACTION_MINUTES = 10
export const CODE_SECONDS = 60
// A person who just set up the second factor reads their recovery codes
// before going back: the code waits for them (RFC 6749 §4.1.2 suggests 10
// minutes at most).
export const CODE_SECONDS_AFTER_SETUP = 600
export const TOKEN_SECONDS = 300
export const SCOPES = ['openid', 'profile', 'email']
export const EXPIRED = 'El ingreso venció o no existe. Volvé a la aplicación y empezá de nuevo.'

const sha256 = (v) => createHash('sha256').update(v).digest('hex')
const b64url = (buf) => Buffer.from(buf).toString('base64url')

/** The issuer, or null when the provider is off. */
export function issuer(env = process.env) {
  const url = (env.STRATUM_CONSOLE_URL ?? '').trim().replace(/\/+$/, '')
  if (!url) return null
  try {
    const u = new URL(url)
    if (u.protocol !== 'https:' && !isLoopback(u.hostname)) return null
    return url
  } catch {
    return null
  }
}

export function discovery(iss) {
  return {
    issuer: iss,
    authorization_endpoint: `${iss}/api/oidc/authorize`,
    token_endpoint: `${iss}/api/oidc/token`,
    userinfo_endpoint: `${iss}/api/oidc/userinfo`,
    jwks_uri: `${iss}/api/oidc/jwks`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code'],
    subject_types_supported: ['public'],
    id_token_signing_alg_values_supported: ['RS256'],
    token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
    code_challenge_methods_supported: ['S256'],
    scopes_supported: SCOPES,
    claims_supported: ['sub', 'iss', 'aud', 'exp', 'iat', 'auth_time', 'nonce', 'amr',
      'email', 'name', 'org_id', 'team_id'],
  }
}

// ── Clients ──────────────────────────────────────────────────────────────

export function newClientSecret() {
  const raw = `stsec_${randomBytes(32).toString('hex')}`
  return { raw, hash: sha256(raw) }
}
export const newClientId = () => `app_${randomBytes(12).toString('hex')}`

function isLoopback(host) {
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]'
}

/**
 * A redirect URI an application may register: https, or http on loopback
 * for development; no fragment, no credentials. Compared exactly later.
 */
export function redirectUriProblem(value) {
  if (typeof value !== 'string' || value.length > 500) return 'Una dirección de retorno tiene hasta 500 caracteres.'
  let u
  try {
    u = new URL(value)
  } catch {
    return `«${value}» no es una dirección válida.`
  }
  if (u.hash || value.includes('#')) return `«${value}» no puede tener #fragmento.`
  if (u.username || u.password) return `«${value}» no puede tener usuario ni contraseña.`
  if (u.protocol === 'https:') return null
  if (u.protocol === 'http:' && isLoopback(u.hostname)) return null
  return `«${value}» tiene que ser https (o http en localhost, para probar).`
}

// What the console shows of an application (never the secret's hash).
export const CLIENT_COLUMNS = `c.id, c.name, c.redirect_uris, c.require_mfa, c.usage_reports, c.created_at, c.revoked_at`

export function parseRedirectUris(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 10) {
    throw badRequest('Tiene que haber entre una y diez direcciones de retorno.')
  }
  const uris = [...new Set(value.map(v => (typeof v === 'string' ? v.trim() : v)))]
  for (const u of uris) {
    const problem = redirectUriProblem(u)
    if (problem) throw badRequest(problem)
  }
  return uris
}

export function parseAppName(value) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 100) {
    throw badRequest('El nombre es obligatorio (hasta 100 caracteres).')
  }
  return value.trim()
}

/** The client if `secret` is its current secret and it is not revoked. */
export async function authenticateClient(db, clientId, secret) {
  if (typeof clientId !== 'string' || typeof secret !== 'string' || clientId.length > 100 || secret.length > 200) return null
  const { rows: [c] } = await db.query(
    `SELECT c.id, c.org_id, c.name, c.secret_hash, c.redirect_uris, c.usage_reports
       FROM oidc_clients c JOIN organizations o ON o.id = c.org_id
      WHERE c.id = $1 AND c.revoked_at IS NULL AND o.status = 'active'`, [clientId])
  if (!c) return null
  const given = Buffer.from(sha256(secret), 'hex')
  const stored = Buffer.from(c.secret_hash, 'hex')
  if (given.length !== stored.length || !timingSafeEqual(given, stored)) return null
  return c
}

/** Client credentials from the Authorization header or the form. */
export function clientCredentials(req, form) {
  const h = req.headers.get('authorization') ?? ''
  if (/^basic /i.test(h)) {
    const decoded = Buffer.from(h.slice(6).trim(), 'base64').toString('utf8')
    const i = decoded.indexOf(':')
    if (i < 0) return {}
    // RFC 6749 §2.3.1: both parts are form-urlencoded inside Basic.
    const dec = (s) => { try { return decodeURIComponent(s.replace(/\+/g, ' ')) } catch { return s } }
    return { id: dec(decoded.slice(0, i)), secret: dec(decoded.slice(i + 1)) }
  }
  return { id: form.get('client_id') ?? undefined, secret: form.get('client_secret') ?? undefined }
}

// ── Authorization request ────────────────────────────────────────────────

/**
 * Checks an authorization request. Errors in client_id or redirect_uri are
 * shown on the console's sign-in page, by code (an application that is not
 * who it says must not get a redirect, and the page shows only its own
 * words); the rest go back to the application as error=...
 */
export async function checkAuthorize(db, q) {
  const clientId = q.get('client_id')
  const redirectUri = q.get('redirect_uri')
  const { rows: [client] } = clientId && clientId.length <= 100 ? await db.query(
    `SELECT c.id, c.org_id, c.name, c.redirect_uris, c.require_mfa, o.name AS org_name
       FROM oidc_clients c JOIN organizations o ON o.id = c.org_id
      WHERE c.id = $1 AND c.revoked_at IS NULL AND o.status = 'active'`, [clientId]) : { rows: [] }
  if (!client) return { fatal: 'unknown_client' }
  if (!redirectUri || !client.redirect_uris.includes(redirectUri)) return { fatal: 'bad_redirect_uri' }
  const back = (error, description) => ({ client, redirect: errorRedirect(redirectUri, q.get('state'), error, description) })
  if (q.get('response_type') !== 'code') return back('unsupported_response_type', 'only response_type=code')
  const scope = (q.get('scope') ?? '').split(' ').filter(Boolean)
  if (!scope.includes('openid')) return back('invalid_scope', 'scope must include openid')
  const challenge = q.get('code_challenge') ?? ''
  if (q.get('code_challenge_method') !== 'S256' || !/^[A-Za-z0-9_-]{43}$/.test(challenge)) {
    return back('invalid_request', 'PKCE with code_challenge_method=S256 is required')
  }
  if (q.get('request') || q.get('request_uri')) return back('request_not_supported', 'request objects are not supported')
  const state = q.get('state')
  const nonce = q.get('nonce')
  if ((state && state.length > 500) || (nonce && nonce.length > 500)) return back('invalid_request', 'state or nonce too long')
  return {
    client,
    params: {
      redirect_uri: redirectUri, state, nonce,
      scope: scope.filter(s => SCOPES.includes(s)).join(' '),
      code_challenge: challenge,
    },
  }
}

export function errorRedirect(redirectUri, state, error, description) {
  const u = new URL(redirectUri)
  u.searchParams.set('error', error)
  if (description) u.searchParams.set('error_description', description)
  if (state) u.searchParams.set('state', state)
  const iss = issuer()
  if (iss) u.searchParams.set('iss', iss)
  return u.toString()
}

export async function createInteraction(db, clientId, params) {
  const id = randomBytes(32).toString('base64url')
  await db.query('DELETE FROM oidc_interactions WHERE expires_at < now()')
  await db.query(
    `INSERT INTO oidc_interactions (id_hash, client_id, params, expires_at)
     VALUES ($1, $2, $3, now() + make_interval(mins => $4))`,
    [sha256(id), clientId, params, INTERACTION_MINUTES])
  return id
}

/** A live interaction with its client and organization, or null. */
export async function loadInteraction(db, id) {
  if (typeof id !== 'string' || id.length < 32 || id.length > 100) return null
  const { rows: [i] } = await db.query(
    `SELECT i.id_hash, i.params, i.user_id, c.id AS client_id, c.name AS client_name, c.org_id,
            c.require_mfa, o.name AS org_name
       FROM oidc_interactions i
       JOIN oidc_clients c ON c.id = i.client_id AND c.revoked_at IS NULL
       JOIN organizations o ON o.id = c.org_id AND o.status = 'active'
      WHERE i.id_hash = $1 AND i.expires_at > now()`, [sha256(id)])
  return i ?? null
}

/**
 * Ends the interaction with a code for `userId`, valid `ttlSeconds`, and
 * returns where to send the browser. The interaction is deleted in the same statement that reads
 * it, so it yields one code at most.
 */
export async function finishInteraction(db, interaction, userId, amr, ttlSeconds = CODE_SECONDS) {
  const { rowCount } = await db.query('DELETE FROM oidc_interactions WHERE id_hash = $1', [interaction.id_hash])
  if (!rowCount) return null
  const code = randomBytes(32).toString('base64url')
  await db.query('DELETE FROM oidc_codes WHERE expires_at < now() - interval \'1 hour\'')
  await db.query(
    `INSERT INTO oidc_codes (code_hash, client_id, user_id, params, amr, auth_time, expires_at)
     VALUES ($1, $2, $3, $4, $5, now(), now() + make_interval(secs => $6))`,
    [sha256(code), interaction.client_id, userId, interaction.params, amr, ttlSeconds])
  const u = new URL(interaction.params.redirect_uri)
  u.searchParams.set('code', code)
  if (interaction.params.state) u.searchParams.set('state', interaction.params.state)
  u.searchParams.set('iss', issuer())
  return u.toString()
}

/**
 * Redeems a code: single use (a conditional UPDATE), not expired, issued to
 * this client for this redirect_uri, and the verifier matches the
 * challenge. Returns the code's row or null.
 */
export async function redeemCode(db, { code, client, redirectUri, verifier }) {
  if (typeof code !== 'string' || code.length < 32 || code.length > 100) return null
  if (typeof verifier !== 'string' || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return null
  const { rows: [c] } = await db.query(
    `UPDATE oidc_codes SET used_at = now()
      WHERE code_hash = $1 AND used_at IS NULL AND expires_at > now() AND client_id = $2
      RETURNING user_id, params, amr, auth_time`,
    [sha256(code), client.id])
  if (!c) return null
  if (c.params.redirect_uri !== redirectUri) return null
  if (b64url(createHash('sha256').update(verifier).digest()) !== c.params.code_challenge) return null
  return c
}

/** The person as an application sees them, if they may still sign in. */
export async function appUser(db, userId, orgId) {
  const { rows: [u] } = await db.query(
    `SELECT u.id, u.email, u.name, u.team_id::text AS team_id, u.org_id::text AS org_id
       FROM users u JOIN organizations o ON o.id = u.org_id
      WHERE u.id = $1 AND u.org_id = $2 AND o.status = 'active'
        AND COALESCE(u.is_active, true) AND COALESCE(u.app_access, true) AND u.team_id IS NOT NULL`,
    [userId, orgId])
  return u ?? null
}

// ── Keys and tokens ──────────────────────────────────────────────────────

let cached = null // { at, key }

/**
 * The current signing key, created on first use. Two replicas starting at
 * once serialize on an advisory lock, so only one key is made.
 *
 * Keys are not rotated on a schedule yet: retire one by setting retired_at
 * (it stays in JWKS for a day) and the next sign-in makes a new one.
 */
export async function signingKey(db, retry = false) {
  if (cached && Date.now() - cached.at < 5 * 60_000) return cached.key
  const load = async (q) => (await q(
    `SELECT kid, public_jwk, private_pem_encrypted FROM oidc_keys
      WHERE retired_at IS NULL ORDER BY created_at DESC LIMIT 1`)).rows[0]
  let row = await load((s) => db.query(s))
  if (!row) {
    const client = await db.connect()
    try {
      await client.query('BEGIN')
      await client.query('SELECT pg_advisory_xact_lock(4723030)')
      row = await load((s) => client.query(s))
      if (!row) {
        const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
        const kid = randomBytes(8).toString('hex')
        const jwk = { ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' }
        const encrypted = encryptSecret(privateKey.export({ type: 'pkcs8', format: 'pem' }))
        await client.query(
          'INSERT INTO oidc_keys (kid, public_jwk, private_pem_encrypted) VALUES ($1, $2, $3)',
          [kid, jwk, encrypted])
        row = { kid, public_jwk: jwk, private_pem_encrypted: encrypted }
      }
      await client.query('COMMIT')
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {})
      throw err
    } finally {
      client.release()
    }
  }
  let privateKey
  try {
    privateKey = createPrivateKey(decryptSecret(row.private_pem_encrypted))
  } catch (err) {
    // STRATUM_ENCRYPTION_KEY changed: the key cannot be used any more. A
    // signing key is disposable (applications fetch JWKS), so retire it and
    // make a new one; sign-ins in flight fail once.
    if (retry) throw err
    console.error(`[oidc] signing key ${row.kid} cannot be decrypted (${err.message}); making a new one`)
    await db.query('UPDATE oidc_keys SET retired_at = now() WHERE kid = $1 AND retired_at IS NULL', [row.kid])
    cached = null
    return signingKey(db, true)
  }
  const key = { kid: row.kid, jwk: row.public_jwk, privateKey }
  cached = { at: Date.now(), key }
  return key
}

/** Public keys for JWKS: current ones and those retired in the last day. */
export async function publicKeys(db) {
  const { rows } = await db.query(
    `SELECT public_jwk FROM oidc_keys
      WHERE retired_at IS NULL OR retired_at > now() - interval '1 day'
      ORDER BY created_at DESC`)
  return rows.map(r => r.public_jwk)
}

export function signJwt(key, claims, typ = 'JWT') {
  const header = b64url(JSON.stringify({ alg: 'RS256', kid: key.kid, typ }))
  const body = b64url(JSON.stringify(claims))
  const sig = sign('RSA-SHA256', Buffer.from(`${header}.${body}`), key.privateKey)
  return `${header}.${body}.${b64url(sig)}`
}

/** Claims of a token this provider signed, or null (bad signature, expired, wrong type). */
export async function verifyJwt(db, token, { typ, aud }) {
  if (typeof token !== 'string' || token.length > 4096) return null
  const parts = token.split('.')
  if (parts.length !== 3) return null
  let header, claims
  try {
    header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'))
    claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
  } catch {
    return null
  }
  if (header.alg !== 'RS256' || header.typ !== typ) return null
  const jwk = (await publicKeys(db)).find(k => k.kid === header.kid)
  if (!jwk) return null
  const ok = verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), createPublicKey({ key: jwk, format: 'jwk' }),
    Buffer.from(parts[2], 'base64url'))
  if (!ok) return null
  const now = Math.floor(Date.now() / 1000)
  if (typeof claims.exp !== 'number' || claims.exp <= now) return null
  if (claims.iss !== issuer() || claims.aud !== aud) return null
  return claims
}

/** The ID token and access token for a redeemed code. */
export async function issueTokens(db, { client, user, code }) {
  const key = await signingKey(db)
  const iss = issuer()
  const now = Math.floor(Date.now() / 1000)
  const scope = (code.params.scope ?? 'openid').split(' ')
  const profile = {
    ...(scope.includes('email') ? { email: user.email } : {}),
    ...(scope.includes('profile') ? { name: user.name || user.email } : {}),
    org_id: user.org_id,
    team_id: user.team_id,
  }
  const idToken = signJwt(key, {
    iss, sub: user.id, aud: client.id, iat: now, exp: now + TOKEN_SECONDS,
    auth_time: Math.floor(new Date(code.auth_time).getTime() / 1000),
    ...(code.params.nonce ? { nonce: code.params.nonce } : {}),
    amr: code.amr,
    ...profile,
  })
  const accessToken = signJwt(key, {
    iss, sub: user.id, aud: `${iss}/api/oidc/userinfo`, client_id: client.id,
    iat: now, exp: now + TOKEN_SECONDS, scope: scope.join(' '),
  }, 'at+jwt')
  return {
    access_token: accessToken, token_type: 'Bearer', expires_in: TOKEN_SECONDS,
    id_token: idToken, scope: scope.join(' '),
  }
}

/** Test hook: forget the cached key. */
export function resetKeyCache() { cached = null }
