// The console as an OpenID Connect provider (lib/oidc.js, migration 030):
// registering applications, the authorization code flow with PKCE, the
// tokens, and who may sign in.
//
//   DATABASE_URL=postgres://... node --import ./test/register.mjs --test test/
//
// Skipped without DATABASE_URL.

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, createPublicKey, randomBytes, randomUUID, verify } from 'node:crypto'

process.env.STRATUM_ENCRYPTION_KEY ??= randomBytes(32).toString('hex')
process.env.STRATUM_CONSOLE_URL = 'http://localhost:3000'
const ISS = 'http://localhost:3000'

const { NextRequest } = await import('next/server.js')
const pg = (await import('pg')).default
const { hashPassword } = await import('../lib/password.js')
const { closeDb } = await import('../lib/db.js')
const totp = await import('../lib/totp.js')
const { redirectUriProblem, resetKeyCache } = await import('../lib/oidc.js')

const url = process.env.DATABASE_URL
const skip = url ? false : 'DATABASE_URL not set'
const PASSWORD = 'correct horse battery'
let db
const orgs = []
const sql = async (text, params = []) => (await db.query(text, params)).rows

const mods = {}
async function call(path, method, { cookie, body, form, query = '', params = {}, headers = {} } = {}) {
  mods[path] ??= path === '.well-known'
    ? await import('../app/.well-known/openid-configuration/route.js')
    : await import(`../app/api/${path}/route.js`)
  const h = { ...headers }
  if (cookie) h.cookie = `stratum_session=${cookie}`
  let payload
  if (body !== undefined) { h['content-type'] = 'application/json'; payload = JSON.stringify(body) }
  if (form !== undefined) { h['content-type'] = 'application/x-www-form-urlencoded'; payload = new URLSearchParams(form).toString() }
  const req = new NextRequest(`${ISS}/api/${path}${query}`, { method, headers: h, body: payload })
  const res = await mods[path][method](req, { params: Promise.resolve(params) })
  const text = await res.text()
  let parsed = null
  try { parsed = text ? JSON.parse(text) : null } catch { parsed = text }
  return { status: res.status, body: parsed, res }
}

async function person(org, team, role, { appAccess = true } = {}) {
  const email = `${role}-${randomUUID().slice(0, 8)}@example.com`
  const [u] = await sql(
    `INSERT INTO users (org_id, team_id, email, name, role, password_hash, app_access)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [org, team, email, `Persona ${role}`, role, await hashPassword(PASSWORD), appAccess])
  return { id: u.id, email }
}

async function consoleSession(email) {
  const r = await call('session', 'POST', { body: { email, password: PASSWORD } })
  const cookie = r.res.cookies.get('stratum_session').value
  await sql('UPDATE console_sessions SET enrollment_only = false WHERE token_hash = $1',
    [createHash('sha256').update(cookie).digest('hex')])
  return cookie
}

let O
before(async () => {
  if (!url) return
  db = new pg.Pool({ connectionString: url, max: 2 })
  resetKeyCache()
  const mk = async () => {
    const id = randomUUID()
    orgs.push(id)
    await sql('INSERT INTO organizations (id, name) VALUES ($1, $2)', [id, `Acme ${id.slice(0, 4)}`])
    const [team] = await sql(`INSERT INTO teams (org_id, name) VALUES ($1, 'Eng') RETURNING id`, [id])
    return { id, team: team.id }
  }
  const a = await mk()
  const b = await mk()
  const owner = await person(a.id, null, 'owner')
  const manager = await person(a.id, a.team, 'team_manager')
  O = {
    org: a.id, team: a.team,
    owner: await consoleSession(owner.email),
    manager: await consoleSession(manager.email),
    ana: await person(a.id, a.team, 'member'),
    noApps: await person(a.id, a.team, 'member', { appAccess: false }),
    noTeam: await person(a.id, null, 'member'),
    stranger: await person(b.id, b.team, 'member'),
  }
})

after(async () => {
  if (!db) return
  await sql('DELETE FROM organizations WHERE id = ANY($1::uuid[])', [orgs])
  await db.end()
  await closeDb()
})

const pkce = () => {
  const verifier = randomBytes(32).toString('base64url')
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') }
}

async function authorize(app, extra = {}) {
  const p = pkce()
  const q = new URLSearchParams({
    response_type: 'code', client_id: app.id, redirect_uri: app.redirect, scope: 'openid email profile',
    state: 'st-1', nonce: 'n-1', code_challenge: p.challenge, code_challenge_method: 'S256', ...extra,
  })
  const r = await call('oidc/authorize', 'GET', { query: `?${q}` })
  return { ...p, status: r.status, location: r.res.headers.get('location') }
}

const interactionOf = (location) => new URL(location).searchParams.get('i')

async function register(body) {
  const r = await call('apps', 'POST', { cookie: O.owner, body })
  assert.equal(r.status, 201, JSON.stringify(r.body))
  return { id: r.body.app.id, secret: r.body.clientSecret, redirect: body.redirectUris[0] }
}

async function token(app, form, secret = app.secret) {
  return call('oidc/token', 'POST', {
    form: { grant_type: 'authorization_code', redirect_uri: app.redirect, ...form },
    headers: { authorization: `Basic ${Buffer.from(`${app.id}:${secret}`).toString('base64')}` },
  })
}

test('oidc: redirect URIs an application may register', () => {
  assert.equal(redirectUriProblem('https://chat.acme.com/cb'), null)
  assert.equal(redirectUriProblem('http://localhost:3001/cb'), null)
  assert.match(redirectUriProblem('http://chat.acme.com/cb'), /https/)
  assert.match(redirectUriProblem('https://chat.acme.com/cb#x'), /fragmento/)
  assert.match(redirectUriProblem('https://u:p@chat.acme.com/cb'), /usuario/)
  assert.match(redirectUriProblem('javascript:alert(1)'), /https/)
})

test('oidc: only an Owner or Admin registers applications; the secret is shown once', { skip }, async () => {
  const body = { name: 'Portal', redirectUris: ['https://chat.acme.com/cb'] }
  assert.equal((await call('apps', 'POST', { cookie: O.manager, body })).status, 403)
  assert.equal((await call('apps', 'POST', { cookie: O.owner, body: { ...body, redirectUris: ['http://chat.acme.com/cb'] } })).status, 400)
  const r = await call('apps', 'POST', { cookie: O.owner, body })
  assert.equal(r.status, 201)
  assert.match(r.body.clientSecret, /^stsec_[0-9a-f]{64}$/)
  assert.equal(r.body.app.require_mfa, true)
  const list = await call('apps', 'GET', { cookie: O.owner })
  assert.equal(list.body.issuer, ISS)
  assert.ok(!JSON.stringify(list.body).includes(r.body.clientSecret))
  assert.ok(!JSON.stringify(list.body).includes('secret_hash'))
})

test('oidc: discovery and keys', { skip }, async () => {
  const d = await call('.well-known', 'GET')
  assert.equal(d.body.issuer, ISS)
  assert.equal(d.body.token_endpoint, `${ISS}/api/oidc/token`)
  assert.deepEqual(d.body.code_challenge_methods_supported, ['S256'])
  const k = await call('oidc/jwks', 'GET')
  assert.ok(k.body.keys.length >= 1)
  assert.ok(k.body.keys.every(key => key.kty === 'RSA' && key.alg === 'RS256' && key.kid), 'RS256 keys with ids')
  assert.ok(k.body.keys.every(key => !('d' in key) && !('p' in key)), 'no private parts')
})

test('oidc: a sign-in, from authorize to userinfo', { skip }, async () => {
  const app = await register({ name: 'Portal de chat', redirectUris: ['https://chat.acme.com/cb'], requireMfa: false })

  const a = await authorize(app)
  assert.equal(a.status, 302)
  assert.match(a.location, /^http:\/\/localhost:3000\/oidc\/login\?i=/)
  const i = interactionOf(a.location)
  const info = await call('oidc/interaction', 'GET', { query: `?i=${i}` })
  assert.equal(info.body.client, 'Portal de chat')

  const login = await call('oidc/login', 'POST', { body: { i, email: O.ana.email, password: PASSWORD } })
  assert.equal(login.status, 200, JSON.stringify(login.body))
  const back = new URL(login.body.redirect)
  assert.equal(`${back.origin}${back.pathname}`, app.redirect)
  assert.equal(back.searchParams.get('state'), 'st-1')
  assert.equal(back.searchParams.get('iss'), ISS)
  const code = back.searchParams.get('code')

  // The interaction is spent.
  assert.equal((await call('oidc/login', 'POST', { body: { i, email: O.ana.email, password: PASSWORD } })).status, 404)

  assert.equal((await token(app, { code, code_verifier: a.verifier }, 'stsec_wrong')).status, 401)
  assert.equal((await token(app, { code, code_verifier: pkce().verifier })).body.error, 'invalid_grant',
    'a wrong verifier spends the code too')

  // A fresh code, redeemed properly.
  const a2 = await authorize(app)
  const l2 = await call('oidc/login', 'POST', { body: { i: interactionOf(a2.location), email: O.ana.email, password: PASSWORD } })
  const code2 = new URL(l2.body.redirect).searchParams.get('code')
  const t = await token(app, { code: code2, code_verifier: a2.verifier })
  assert.equal(t.status, 200, JSON.stringify(t.body))
  assert.equal(t.res.headers.get('cache-control'), 'no-store')
  assert.equal(t.body.token_type, 'Bearer')
  assert.equal((await token(app, { code: code2, code_verifier: a2.verifier })).body.error, 'invalid_grant', 'single use')

  // The ID token: signed with a key from JWKS, for this application.
  const [h, p, s] = t.body.id_token.split('.')
  const header = JSON.parse(Buffer.from(h, 'base64url'))
  const claims = JSON.parse(Buffer.from(p, 'base64url'))
  const jwk = (await call('oidc/jwks', 'GET')).body.keys.find(k => k.kid === header.kid)
  assert.ok(verify('RSA-SHA256', Buffer.from(`${h}.${p}`), createPublicKey({ key: jwk, format: 'jwk' }), Buffer.from(s, 'base64url')))
  assert.equal(claims.iss, ISS)
  assert.equal(claims.aud, app.id)
  assert.equal(claims.sub, O.ana.id)
  assert.equal(claims.nonce, 'n-1')
  assert.equal(claims.email, O.ana.email)
  assert.equal(claims.team_id, O.team)
  assert.equal(claims.org_id, O.org)
  assert.deepEqual(claims.amr, ['pwd'])
  assert.ok(claims.exp - claims.iat === 300)

  const ui = await call('oidc/userinfo', 'GET', { headers: { authorization: `Bearer ${t.body.access_token}` } })
  assert.equal(ui.status, 200)
  assert.deepEqual({ sub: ui.body.sub, email: ui.body.email, team: ui.body.team_id }, { sub: O.ana.id, email: O.ana.email, team: O.team })
  // The ID token is not an access token.
  assert.equal((await call('oidc/userinfo', 'GET', { headers: { authorization: `Bearer ${t.body.id_token}` } })).status, 401)

  // Losing access to applications ends what the tokens can do.
  await sql('UPDATE users SET app_access = false WHERE id = $1', [O.ana.id])
  assert.equal((await call('oidc/userinfo', 'GET', { headers: { authorization: `Bearer ${t.body.access_token}` } })).status, 401)
  await sql('UPDATE users SET app_access = true WHERE id = $1', [O.ana.id])

  const audit = await sql(`SELECT action, result FROM audit_log WHERE org_id = $1 AND action LIKE 'app.%' ORDER BY id`, [O.org])
  assert.ok(audit.some(r => r.action === 'app.login' && r.result === 'ok'))
  assert.ok(audit.some(r => r.action === 'app.token'))
})

test('oidc: bad requests never reach a foreign redirect', { skip }, async () => {
  const app = await register({ name: 'Portal', redirectUris: ['https://chat.acme.com/cb'], requireMfa: false })
  const evil = await authorize({ ...app, redirect: 'https://evil.example/cb' })
  assert.match(evil.location, /^http:\/\/localhost:3000\/oidc\/login\?error=/, 'an unregistered redirect is shown, not followed')
  const unknown = await authorize({ ...app, id: 'app_000000000000000000000000' })
  assert.match(unknown.location, /\/oidc\/login\?error=/)
  const noPkce = await authorize(app, { code_challenge_method: 'plain' })
  const back = new URL(noPkce.location)
  assert.equal(back.origin + back.pathname, app.redirect)
  assert.equal(back.searchParams.get('error'), 'invalid_request')
  assert.equal(back.searchParams.get('state'), 'st-1')
  assert.equal(new URL((await authorize(app, { scope: 'email' })).location).searchParams.get('error'), 'invalid_scope')
})

test('oidc: who may sign in', { skip }, async () => {
  const app = await register({ name: 'Portal', redirectUris: ['https://chat.acme.com/cb'], requireMfa: false })
  for (const [who, email] of [['another organization', O.stranger.email], ['without access to applications', O.noApps.email],
    ['without a team', O.noTeam.email], ['a wrong password', null]]) {
    const a = await authorize(app)
    const r = await call('oidc/login', 'POST', { body: { i: interactionOf(a.location), email: email ?? O.ana.email, password: email ? PASSWORD : 'nope' } })
    assert.equal(r.status, 401, who)
    assert.equal(r.body.error, 'invalid_credentials', who)
  }
  // A Member signs in to applications though they cannot use the console.
  const consoleTry = await call('session', 'POST', { body: { email: O.ana.email, password: PASSWORD } })
  assert.equal(consoleTry.status, 401)
})

test('oidc: an application that asks for a second factor', { skip }, async () => {
  const app = await register({ name: 'Portal seguro', redirectUris: ['https://chat.acme.com/cb'] })
  const bea = await person(O.org, O.team, 'member')

  // Without one, she sets it up during the sign-in.
  const a = await authorize(app)
  const i = interactionOf(a.location)
  const r = await call('oidc/login', 'POST', { body: { i, email: bea.email, password: PASSWORD } })
  assert.equal(r.body.mfa_enrollment_required, true)
  assert.match(r.body.qr_svg, /^<svg/)
  assert.equal((await call('oidc/login/mfa', 'POST', { body: { i, challenge: r.body.challenge, code: '000000' } })).status, 401)
  const done = await call('oidc/login/mfa', 'POST', {
    body: { i, challenge: r.body.challenge, code: totp.codeAt(r.body.secret, totp.stepAt()) } })
  assert.equal(done.status, 200, JSON.stringify(done.body))
  assert.equal(done.body.recovery_codes.length, 10)
  const t = await token(app, { code: new URL(done.body.redirect).searchParams.get('code'), code_verifier: a.verifier })
  assert.deepEqual(JSON.parse(Buffer.from(t.body.id_token.split('.')[1], 'base64url')).amr, ['pwd', 'otp'])
  const [{ totp_enabled_at }] = await sql('SELECT totp_enabled_at FROM users WHERE id = $1', [bea.id])
  assert.ok(totp_enabled_at)

  // Next time: the code from the authenticator. A challenge from another
  // interaction does not count.
  const a2 = await authorize(app)
  const i2 = interactionOf(a2.location)
  const r2 = await call('oidc/login', 'POST', { body: { i: i2, email: bea.email, password: PASSWORD } })
  assert.equal(r2.body.mfa_required, true)
  const other = await authorize(app)
  assert.equal((await call('oidc/login/mfa', 'POST', {
    body: { i: interactionOf(other.location), challenge: r2.body.challenge, code: '123456' } })).status, 401)
  const [{ secret }] = await sql('SELECT totp_secret_encrypted AS secret FROM users WHERE id = $1', [bea.id])
  const { decryptSecret } = await import('../lib/secrets.js')
  const ok = await call('oidc/login/mfa', 'POST', {
    body: { i: i2, challenge: r2.body.challenge, code: totp.codeAt(decryptSecret(secret), totp.stepAt() + 1) } })
  assert.equal(ok.status, 200, JSON.stringify(ok.body))
  assert.equal(ok.body.recovery_codes, undefined)
})

test('oidc: a key that cannot be decrypted any more is replaced', { skip }, async () => {
  const { signingKey } = await import('../lib/oidc.js')
  resetKeyCache()
  const before = await signingKey(db)
  await sql(`UPDATE oidc_keys SET private_pem_encrypted = 'aa:Zm9v' WHERE kid = $1`, [before.kid])
  resetKeyCache()
  const after = await signingKey(db)
  assert.notEqual(after.kid, before.kid)
  const [{ retired_at }] = await sql('SELECT retired_at FROM oidc_keys WHERE kid = $1', [before.kid])
  assert.ok(retired_at)
})

test('oidc: a revoked application', { skip }, async () => {
  const app = await register({ name: 'Viejo', redirectUris: ['https://old.acme.com/cb'], requireMfa: false })
  const a = await authorize(app)
  const l = await call('oidc/login', 'POST', { body: { i: interactionOf(a.location), email: O.ana.email, password: PASSWORD } })
  const code = new URL(l.body.redirect).searchParams.get('code')
  assert.equal((await call('apps/[id]', 'DELETE', { cookie: O.owner, params: { id: app.id } })).status, 200)
  assert.equal((await token(app, { code, code_verifier: a.verifier })).status, 401)
  assert.match((await authorize(app)).location, /\/oidc\/login\?error=/)
})
