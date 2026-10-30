// An OpenID Connect identity provider for the console's end-to-end test
// (signing in with the organization's provider, lib/sso.js). It signs in
// whoever the console names in login_hint, at once, with a verified email:
// the console decides whether that person may get in.
//
//   PORT (default 18090). Issuer http://127.0.0.1:<PORT>.
//   GET /requests → the token requests it answered (to check PKCE).
import { createServer } from 'node:http'
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto'

const PORT = Number(process.env.PORT ?? 18090)
const ISS = `http://127.0.0.1:${PORT}`
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'mock-1', alg: 'RS256', use: 'sig' }
const codes = new Map()
const answered = []

function idToken(claims) {
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
  const head = `${enc({ alg: 'RS256', kid: jwk.kid, typ: 'JWT' })}.${enc(claims)}`
  return `${head}.${sign('RSA-SHA256', Buffer.from(head), privateKey).toString('base64url')}`
}

createServer(async (req, res) => {
  const u = new URL(req.url, ISS)
  const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) }
  if (u.pathname === '/.well-known/openid-configuration') {
    return send(200, { issuer: ISS, authorization_endpoint: `${ISS}/authorize`, token_endpoint: `${ISS}/token`, jwks_uri: `${ISS}/jwks` })
  }
  if (u.pathname === '/jwks') return send(200, { keys: [jwk] })
  if (u.pathname === '/requests') return send(200, { requests: answered })
  if (u.pathname === '/authorize') {
    const q = u.searchParams
    const code = randomBytes(16).toString('hex')
    codes.set(code, { email: q.get('login_hint'), nonce: q.get('nonce'), challenge: q.get('code_challenge'), client: q.get('client_id'), redirect: q.get('redirect_uri') })
    const back = new URL(q.get('redirect_uri'))
    back.searchParams.set('code', code)
    back.searchParams.set('state', q.get('state'))
    res.writeHead(302, { location: back.toString() })
    return res.end()
  }
  if (u.pathname === '/token' && req.method === 'POST') {
    let raw = ''
    for await (const c of req) raw += c
    const f = new URLSearchParams(raw)
    const c = codes.get(f.get('code'))
    codes.delete(f.get('code'))
    const pkce = c && createHash('sha256').update(f.get('code_verifier') ?? '').digest('base64url') === c.challenge
    answered.push({ client_id: f.get('client_id'), pkce: Boolean(pkce) })
    if (!c || !pkce || f.get('redirect_uri') !== c.redirect || f.get('client_id') !== c.client) return send(400, { error: 'invalid_grant' })
    const now = Math.floor(Date.now() / 1000)
    return send(200, {
      access_token: randomBytes(16).toString('hex'), token_type: 'Bearer', expires_in: 300,
      id_token: idToken({ iss: ISS, aud: c.client, sub: c.email, email: c.email, email_verified: true, nonce: c.nonce, iat: now, exp: now + 300 }),
    })
  }
  send(404, { error: 'not_found' })
}).listen(PORT, '127.0.0.1', () => console.log(`mock-idp on ${ISS}`))
