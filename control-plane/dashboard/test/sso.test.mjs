// Signing in with the organization's identity provider (lib/sso.js), against
// a provider faked in this process.
//
//   DATABASE_URL=postgres://... node --import ./test/register.mjs --test test/
//
// The database steps are skipped without DATABASE_URL.

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto'

process.env.STRATUM_ENCRYPTION_KEY ??= 'ab'.repeat(32)
process.env.STRATUM_CONSOLE_URL = 'https://console.example.com'

const sso = await import('../lib/sso.js')
const { encryptSecret } = await import('../lib/secrets.js')
const { verifyIdToken, provenEmail, parseDomains, parseIssuer, domainOf, SsoError } = sso

const ISS = 'https://idp.example.com'
const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 })
const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' })
const jwk = (k, kid, alg) => ({ ...k.publicKey.export({ format: 'jwk' }), kid, alg, use: 'sig' })
let keys = [jwk(rsa, 'r1', 'RS256'), jwk(ec, 'e1', 'ES256')]

function jwt(claims, { kid = 'r1', key = rsa.privateKey, alg = 'RS256' } = {}) {
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
  const head = `${enc({ alg, kid, typ: 'JWT' })}.${enc(claims)}`
  const sig = alg === 'ES256'
    ? sign('SHA256', Buffer.from(head), { key, dsaEncoding: 'ieee-p1363' })
    : sign('RSA-SHA256', Buffer.from(head), key)
  return `${head}.${sig.toString('base64url')}`
}

const now = () => Math.floor(Date.now() / 1000)
const claims = (over = {}) => ({ iss: ISS, aud: 'client-1', exp: now() + 300, iat: now(), nonce: 'n1', email: 'ana@acme.com', email_verified: true, ...over })

// The provider: discovery, keys and a token endpoint that answers with `idToken`.
let idToken = null
let tokenRequests = []
async function fakeFetch(url, init = {}) {
  const u = String(url)
  const ok = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
  if (u === `${ISS}/.well-known/openid-configuration`) {
    return ok({ issuer: ISS, authorization_endpoint: `${ISS}/authorize`, token_endpoint: `${ISS}/token`, jwks_uri: `${ISS}/jwks` })
  }
  if (u === `${ISS}/jwks`) return ok({ keys })
  if (u === `${ISS}/token`) {
    tokenRequests.push(Object.fromEntries(new URLSearchParams(String(init.body))))
    return idToken ? ok({ id_token: typeof idToken === 'function' ? idToken() : idToken, access_token: 'x' }) : new Response('{"error":"invalid_grant"}', { status: 400 })
  }
  return new Response('not found', { status: 404 })
}
const verifyOpts = (over = {}) => ({ iss: ISS, clientId: 'client-1', nonce: 'n1', jwksUri: `${ISS}/jwks`, fetchImpl: fakeFetch, ...over })
const refuses = async (p, code) => {
  try { await p } catch (err) { assert.ok(err instanceof SsoError, err.message); assert.equal(err.code, code, err.message); return err }
  assert.fail(`expected ${code}`)
}

test('an ID token: signature, issuer, audience, expiry and nonce; RS256 and ES256', async () => {
  sso.resetSsoCache()
  assert.equal((await verifyIdToken(jwt(claims()), verifyOpts())).email, 'ana@acme.com')
  assert.equal((await verifyIdToken(jwt(claims(), { kid: 'e1', key: ec.privateKey, alg: 'ES256' }), verifyOpts())).email, 'ana@acme.com')
  await refuses(verifyIdToken(jwt(claims({ nonce: 'other' })), verifyOpts()), 'bad_token')
  await refuses(verifyIdToken(jwt(claims({ aud: 'client-2' })), verifyOpts()), 'bad_token')
  await refuses(verifyIdToken(jwt(claims({ iss: 'https://evil.example.com' })), verifyOpts()), 'bad_token')
  await refuses(verifyIdToken(jwt(claims({ exp: now() - 120 })), verifyOpts()), 'bad_token')
  const other = generateKeyPairSync('rsa', { modulusLength: 2048 })
  await refuses(verifyIdToken(jwt(claims(), { key: other.privateKey }), verifyOpts()), 'bad_token')
  const forged = jwt(claims()).split('.')
  await refuses(verifyIdToken(`${forged[0]}.${Buffer.from(JSON.stringify(claims({ email: 'boss@acme.com' }))).toString('base64url')}.${forged[2]}`, verifyOpts()), 'bad_token')
  const none = `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from(JSON.stringify(claims())).toString('base64url')}.`
  await refuses(verifyIdToken(none, verifyOpts()), 'bad_token')
})

test('a key the provider just added is fetched again once', async () => {
  sso.resetSsoCache()
  await verifyIdToken(jwt(claims()), verifyOpts()) // caches r1, e1
  const fresh = generateKeyPairSync('rsa', { modulusLength: 2048 })
  keys = [...keys, jwk(fresh, 'r2', 'RS256')]
  assert.equal((await verifyIdToken(jwt(claims(), { kid: 'r2', key: fresh.privateKey }), verifyOpts())).email, 'ana@acme.com')
})

test('which email the claims prove: verified, of the domains, and with Google a Workspace account', () => {
  const oidc = { kind: 'oidc', domains: ['acme.com'] }
  const google = { kind: 'google', domains: ['acme.com'] }
  assert.equal(provenEmail({ email: 'Ana@Acme.com', email_verified: true }, oidc), 'ana@acme.com')
  assert.throws(() => provenEmail({ email: 'ana@acme.com', email_verified: false }, oidc), /verified/)
  assert.throws(() => provenEmail({ email: 'ana@other.com', email_verified: true }, oidc), /domains/)
  assert.throws(() => provenEmail({ email_verified: true }, oidc), /no email/)
  assert.equal(provenEmail({ email: 'ana@acme.com', email_verified: true, hd: 'acme.com' }, google), 'ana@acme.com')
  assert.throws(() => provenEmail({ email: 'ana@acme.com', email_verified: true }, google), /Workspace/, 'a personal Google account with that address')
})

test('domains and issuers', () => {
  assert.deepEqual(parseDomains([' Acme.com ', '@acme.com.uy', 'acme.com']), ['acme.com', 'acme.com.uy'])
  for (const bad of [[], ['acme'], ['a b.com'], 'acme.com']) assert.throws(() => parseDomains(bad), /./, JSON.stringify(bad))
  assert.equal(parseIssuer('https://login.microsoftonline.com/t/v2.0/'), 'https://login.microsoftonline.com/t/v2.0')
  assert.equal(parseIssuer('http://127.0.0.1:18090'), 'http://127.0.0.1:18090')
  for (const bad of ['http://idp.example.com', 'https://idp.example.com/?x=1', 'nope']) assert.throws(() => parseIssuer(bad), /./, bad)
  assert.equal(domainOf('ana@Acme.COM'), 'acme.com')
})

// ── With the database ───────────────────────────────────────────────────

const url = process.env.DATABASE_URL
const skip = url ? false : 'DATABASE_URL not set'
let db
let O
const orgs = []
const pg = url ? (await import('pg')).default : null
const sql = async (text, params = []) => (await db.query(text, params)).rows

before(async () => {
  if (!url) return
  db = new pg.Pool({ connectionString: url, max: 2 })
  const id = randomUUID()
  orgs.push(id)
  const domain = `acme-${id.slice(0, 8)}.com`
  await sql('INSERT INTO organizations (id, name) VALUES ($1, $2)', [id, `s-${id.slice(0, 8)}`])
  const [team] = await sql(`INSERT INTO teams (org_id, name) VALUES ($1, 'Eng') RETURNING id`, [id])
  const person = async (name, role) => (await sql(
    `INSERT INTO users (org_id, team_id, email, name, role) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [id, team.id, `${name}@${domain}`, name, role]))[0].id
  O = { id, domain, ana: await person('ana', 'member'), owner: await person('jefa', 'owner') }
  await sql(`INSERT INTO sso_providers (org_id, kind, issuer, client_id, client_secret_encrypted, domains, enforce)
             VALUES ($1, 'oidc', $2, 'client-1', $3, $4, true)`, [id, ISS, encryptSecret('s3cret'), [domain]])
})

after(async () => {
  if (!db) return
  await sql('DELETE FROM organizations WHERE id = ANY($1::uuid[])', [orgs])
  await db.end()
})

test('the domain picks the provider; enforcing it refuses the password, except for Owners', { skip }, async () => {
  assert.equal((await sso.providerFor(db, `x@${O.domain}`)).org_id, O.id)
  assert.equal(await sso.providerFor(db, 'x@nobody.example'), null)
  assert.equal(await sso.passwordRefused(db, { email: `ana@${O.domain}`, orgId: O.id, role: 'member' }), true)
  assert.equal(await sso.passwordRefused(db, { email: `jefa@${O.domain}`, orgId: O.id, role: 'owner' }), false)
  assert.equal(await sso.passwordRefused(db, { email: `ana@${O.domain}`, orgId: randomUUID(), role: 'member' }), false, 'another organization')
})

test('a sign-in round trip: PKCE, nonce, the browser half of the state, and only someone already in Users', { skip }, async () => {
  sso.resetSsoCache()
  const email = `ana@${O.domain}`
  const start = await sso.startSso(db, { email, fetchImpl: fakeFetch })
  const q = new URL(start.redirect).searchParams
  assert.equal(new URL(start.redirect).origin + new URL(start.redirect).pathname, `${ISS}/authorize`)
  assert.equal(q.get('redirect_uri'), 'https://console.example.com/api/sso/callback')
  assert.equal(q.get('code_challenge_method'), 'S256')
  assert.equal(q.get('login_hint'), email)

  idToken = () => jwt(claims({ email, nonce: q.get('nonce') }))
  tokenRequests = []
  // Another browser: refused, and the state is gone.
  await refuses(sso.finishSso(db, { state: q.get('state'), code: 'c', browser: 'other', fetchImpl: fakeFetch }), 'expired')
  const again = await sso.startSso(db, { email, fetchImpl: fakeFetch })
  const q2 = new URL(again.redirect).searchParams
  idToken = () => jwt(claims({ email, nonce: q2.get('nonce') }))
  const out = await sso.finishSso(db, { state: q2.get('state'), code: 'c', browser: again.browser, fetchImpl: fakeFetch })
  assert.equal(out.user.id, O.ana)
  const sent = tokenRequests.at(-1)
  assert.equal(createHash('sha256').update(sent.code_verifier).digest('base64url'), q2.get('code_challenge'))
  assert.equal(sent.client_secret, 's3cret')
  // Used once.
  await refuses(sso.finishSso(db, { state: q2.get('state'), code: 'c', browser: again.browser, fetchImpl: fakeFetch }), 'expired')

  // Someone the provider knows and Stratum does not.
  const s3 = await sso.startSso(db, { email: `nueva@${O.domain}`, fetchImpl: fakeFetch })
  const q3 = new URL(s3.redirect).searchParams
  idToken = () => jwt(claims({ email: `nueva@${O.domain}`, nonce: q3.get('nonce') }))
  await refuses(sso.finishSso(db, { state: q3.get('state'), code: 'c', browser: s3.browser, fetchImpl: fakeFetch }), 'unknown_user')

  // The provider says no, or answers for another domain.
  const s4 = await sso.startSso(db, { email, fetchImpl: fakeFetch })
  await refuses(sso.finishSso(db, { state: new URL(s4.redirect).searchParams.get('state'), error: 'access_denied', browser: s4.browser, fetchImpl: fakeFetch }), 'provider_error')
  const s5 = await sso.startSso(db, { email, fetchImpl: fakeFetch })
  const q5 = new URL(s5.redirect).searchParams
  idToken = () => jwt(claims({ email: 'ana@other.example', nonce: q5.get('nonce') }))
  await refuses(sso.finishSso(db, { state: q5.get('state'), code: 'c', browser: s5.browser, fetchImpl: fakeFetch }), 'other_domain')
  await refuses(sso.startSso(db, { email: 'x@nobody.example', fetchImpl: fakeFetch }), 'no_provider')
})

test('public email domains: refused, except on a console that runs on this machine', () => {
  const env = (url) => ({ STRATUM_CONSOLE_URL: url })
  assert.deepEqual(sso.refusedPublicDomains(['acme.com', 'gmail.com', 'Outlook.com'.toLowerCase()], env('https://stratum.acme.com')), ['gmail.com', 'outlook.com'])
  assert.deepEqual(sso.refusedPublicDomains(['gmail.com'], env('http://localhost:3000')), [], 'a demo, with a personal account')
  assert.deepEqual(sso.refusedPublicDomains(['acme.com'], env('https://stratum.acme.com')), [])
})
