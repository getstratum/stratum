// The console's second factor (migration 022, lib/mfa.js, lib/totp.js).
//
//   DATABASE_URL=postgres://... node --import ./test/register.mjs --test test/
//
// The database tests are skipped without DATABASE_URL.

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID, randomBytes } from 'node:crypto'

process.env.STRATUM_ENCRYPTION_KEY ??= randomBytes(32).toString('hex')

const { NextRequest } = await import('next/server.js')
const pg = (await import('pg')).default
const { hashPassword } = await import('../lib/password.js')
const { closeDb } = await import('../lib/db.js')
const totp = await import('../lib/totp.js')

const url = process.env.DATABASE_URL
const skip = url ? false : 'DATABASE_URL not set'
const PASSWORD = 'correct horse battery'
let db
const orgs = []
const sql = async (text, params = []) => (await db.query(text, params)).rows

const mods = {}
async function call(path, method, { as, body, params = {} } = {}) {
  mods[path] ??= await import(`../app/api/${path}/route.js`)
  const headers = {}
  if (as) headers.cookie = `stratum_session=${as}`
  if (body !== undefined) headers['content-type'] = 'application/json'
  const req = new NextRequest(`http://console.test/api/${path}`, {
    method, headers, body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const res = await mods[path][method](req, { params: Promise.resolve(params) })
  const text = await res.text()
  return { status: res.status, body: text ? JSON.parse(text) : null, cookie: res.cookies.get('stratum_session')?.value }
}

const signIn = (email, password = PASSWORD) => call('session', 'POST', { body: { email, password } })

// A code the server has not seen yet. Each code works once, and only the
// current step and the next are accepted, so a test that needs more codes
// than that within 30 s forgets the last accepted step instead of waiting
// (the replay protection itself is tested with the same code twice).
const lastStep = new Map()
async function freshCode(secret, person) {
  let step = Math.max(totp.stepAt(), (lastStep.get(person.id) ?? 0) + 1)
  if (step > totp.stepAt() + 1) {
    await sql('UPDATE users SET totp_last_step = 0 WHERE id = $1', [person.id])
    step = totp.stepAt()
  }
  lastStep.set(person.id, step)
  return totp.codeAt(secret, step)
}

async function org() {
  const id = randomUUID()
  orgs.push(id)
  await sql('INSERT INTO organizations (id, name) VALUES ($1, $2)', [id, `m-${id.slice(0, 8)}`])
  const hash = await hashPassword(PASSWORD)
  const people = {}
  for (const role of ['owner', 'admin', 'auditor']) {
    const email = `${role}-${id.slice(0, 8)}@example.com`
    const [u] = await sql(`INSERT INTO users (org_id, email, role, password_hash) VALUES ($1, $2, $3, $4) RETURNING id`,
      [id, email, role, hash])
    people[role] = { id: u.id, email }
  }
  return { id, ...people }
}

/** Sets up the second factor through the API; returns the secret and codes. */
async function enroll(cookie, person) {
  const setup = await call('session/mfa/setup', 'POST', { as: cookie, body: { password: PASSWORD } })
  assert.equal(setup.status, 200)
  const done = await call('session/mfa/setup', 'PUT', { as: cookie, body: { code: await freshCode(setup.body.secret, person) } })
  assert.equal(done.status, 200)
  return { secret: setup.body.secret, recovery: done.body.recovery_codes }
}

let A

before(async () => {
  if (!url) return
  db = new pg.Pool({ connectionString: url, max: 2 })
  A = await org()
})

after(async () => {
  if (!db) return
  await sql('DELETE FROM organizations WHERE id = ANY($1::uuid[])', [orgs])
  await db.end()
  await closeDb()
})

// --- TOTP ----------------------------------------------------------------------

test('totp: RFC 6238 test vectors (SHA-1, 6 digits)', () => {
  const secret = totp.base32Encode(Buffer.from('12345678901234567890'))
  assert.equal(secret, 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ')
  for (const [seconds, code] of [[59, '287082'], [1111111109, '081804'], [1234567890, '005924'], [2000000000, '279037']]) {
    assert.equal(totp.codeAt(secret, totp.stepAt(seconds * 1000)), code)
  }
  assert.deepEqual(totp.base32Decode(secret), Buffer.from('12345678901234567890'))
})

test('totp: a code is accepted one step around now, and not further', () => {
  const secret = totp.newSecret()
  const now = Date.parse('2026-10-16T12:00:10Z')
  const step = totp.stepAt(now)
  for (const d of [-1, 0, 1]) assert.equal(totp.matchStep(secret, totp.codeAt(secret, step + d), now), step + d)
  for (const d of [-3, 3]) assert.equal(totp.matchStep(secret, totp.codeAt(secret, step + d), now), null)
  assert.equal(totp.matchStep(secret, '12345', now), null)
  assert.equal(totp.matchStep(secret, 'abcdef', now), null)
})

test('recovery codes: ten, distinct, in the shape people type', () => {
  const codes = totp.newRecoveryCodes()
  assert.equal(codes.length, 10)
  assert.equal(new Set(codes).size, 10)
  for (const c of codes) {
    assert.match(c, /^[a-z2-7]{5}-[a-z2-7]{5}$/)
    assert.ok(totp.looksLikeRecoveryCode(c.toUpperCase().replace('-', ' ')))
  }
})

// --- Required for Owner and Admin ------------------------------------------------

test('an owner without a second factor can only set it up', { skip }, async () => {
  const r = await signIn(A.owner.email)
  assert.equal(r.status, 200)
  assert.equal(r.body.mfa_enrollment_required, true)
  const cookie = r.cookie

  const blocked = await call('users', 'GET', { as: cookie })
  assert.equal(blocked.status, 403)
  assert.equal(blocked.body.error, 'mfa_enrollment_required')
  const me = await call('session', 'GET', { as: cookie })
  assert.equal(me.status, 200)
  assert.deepEqual(me.body.permissions, {})
  assert.deepEqual(me.body.mfa, { enabled: false, required: true, enrollmentRequired: true })

  assert.equal((await call('session/mfa/setup', 'POST', { as: cookie, body: { password: 'wrong password!' } })).status, 403)
  const setup = await call('session/mfa/setup', 'POST', { as: cookie, body: { password: PASSWORD } })
  assert.equal(setup.status, 200)
  assert.match(setup.body.secret, /^[A-Z2-7]{32}$/)
  assert.ok(setup.body.uri.startsWith('otpauth://totp/Stratum%3A'))
  assert.ok(setup.body.qr_svg.startsWith('<svg'))
  const [row] = await sql('SELECT totp_pending_secret_encrypted AS p FROM users WHERE id = $1', [A.owner.id])
  assert.ok(row.p && !row.p.includes(setup.body.secret), 'the secret is stored encrypted')

  assert.equal((await call('session/mfa/setup', 'PUT', { as: cookie, body: { code: '000000' } })).status, 400)
  const done = await call('session/mfa/setup', 'PUT', { as: cookie, body: { code: await freshCode(setup.body.secret, A.owner) } })
  assert.equal(done.status, 200)
  assert.equal(done.body.recovery_codes.length, 10)

  // The same session now has both factors.
  assert.equal((await call('users', 'GET', { as: cookie })).status, 200)
  assert.equal((await call('session/mfa/setup', 'POST', { as: cookie, body: { password: PASSWORD } })).status, 409)
  A.owner.secret = setup.body.secret
  A.owner.recovery = done.body.recovery_codes
})

test('with a second factor: the password gives a challenge, the code a session', { skip }, async () => {
  const pw = await signIn(A.owner.email)
  assert.equal(pw.status, 200)
  assert.equal(pw.body.mfa_required, true)
  assert.equal(pw.cookie, undefined, 'no session before the code')

  const wrong = await call('session/mfa', 'POST', { body: { challenge: pw.body.challenge, code: '000000' } })
  assert.equal(wrong.status, 401)
  const code = await freshCode(A.owner.secret, A.owner)
  const ok = await call('session/mfa', 'POST', { body: { challenge: pw.body.challenge, code } })
  assert.equal(ok.status, 200)
  assert.ok(ok.cookie)
  assert.equal((await call('users', 'GET', { as: ok.cookie })).status, 200)

  // The challenge is spent, and the code cannot be used again.
  assert.equal((await call('session/mfa', 'POST', { body: { challenge: pw.body.challenge, code } })).status, 401)
  const again = await signIn(A.owner.email)
  assert.equal((await call('session/mfa', 'POST', { body: { challenge: again.body.challenge, code } })).status, 401)

  const audit = await sql(`SELECT details->>'mfa' AS m FROM audit_log WHERE org_id = $1 AND action = 'session.login' AND result = 'ok'`, [A.id])
  assert.ok(audit.some(a => a.m === 'totp'))
})

test('a recovery code works once', { skip }, async () => {
  const [first] = A.owner.recovery
  const pw = await signIn(A.owner.email)
  const ok = await call('session/mfa', 'POST', { body: { challenge: pw.body.challenge, code: first.toUpperCase() } })
  assert.equal(ok.status, 200)
  assert.equal(ok.body.recovery_codes_left, 9)
  const pw2 = await signIn(A.owner.email)
  assert.equal((await call('session/mfa', 'POST', { body: { challenge: pw2.body.challenge, code: first } })).status, 401)

  // New codes need a code from the authenticator; the old ones stop working.
  // A recovery code is refused before it is checked, so it is not used up.
  assert.equal((await call('session/mfa/recovery-codes', 'POST', { as: ok.cookie, body: { code: A.owner.recovery[1] } })).status, 400)
  const [{ used }] = await sql('SELECT count(*)::int AS used FROM user_recovery_codes WHERE user_id = $1 AND used_at IS NOT NULL', [A.owner.id])
  assert.equal(used, 1, 'only the code used to sign in')
  assert.equal((await call('session/mfa/recovery-codes', 'POST', { as: ok.cookie, body: { code: '000000' } })).status, 403)
  const fresh = await call('session/mfa/recovery-codes', 'POST', { as: ok.cookie, body: { code: await freshCode(A.owner.secret, A.owner) } })
  assert.equal(fresh.status, 200)
  const pw3 = await signIn(A.owner.email)
  assert.equal((await call('session/mfa', 'POST', { body: { challenge: pw3.body.challenge, code: A.owner.recovery[2] } })).status, 401)
  A.owner.recovery = fresh.body.recovery_codes
})

test('a challenge allows 5 tries and lasts 5 minutes', { skip }, async () => {
  const pw = await signIn(A.owner.email)
  for (let i = 0; i < 5; i++) {
    assert.equal((await call('session/mfa', 'POST', { body: { challenge: pw.body.challenge, code: '111111' } })).status, 401)
  }
  const code = await freshCode(A.owner.secret, A.owner)
  assert.equal((await call('session/mfa', 'POST', { body: { challenge: pw.body.challenge, code } })).status, 401, 'out of tries')

  const late = await signIn(A.owner.email)
  await sql(`UPDATE console_login_challenges SET expires_at = now() - interval '1 second' WHERE user_id = $1`, [A.owner.id])
  assert.equal((await call('session/mfa', 'POST', { body: { challenge: late.body.challenge, code: await freshCode(A.owner.secret, A.owner) } })).status, 401)
  // Those failures count against the account like wrong passwords; unlock it for the next tests.
  await sql('UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = $1', [A.owner.id])
})

test('roles that may use it may also turn it off; owners and admins may not', { skip }, async () => {
  const r = await signIn(A.auditor.email)
  assert.equal(r.body.mfa_enrollment_required, false)
  const { secret } = await enroll(r.cookie, A.auditor)
  assert.equal((await call('session/mfa', 'DELETE', { as: r.cookie, body: { password: PASSWORD, code: '000000' } })).status, 403)
  const off = await call('session/mfa', 'DELETE', { as: r.cookie, body: { password: PASSWORD, code: await freshCode(secret, A.auditor) } })
  assert.equal(off.status, 200)
  assert.equal((await signIn(A.auditor.email)).body.mfa_required, undefined)

  const pw = await signIn(A.owner.email)
  const owner = await call('session/mfa', 'POST', { body: { challenge: pw.body.challenge, code: await freshCode(A.owner.secret, A.owner) } })
  assert.equal((await call('session/mfa', 'DELETE', { as: owner.cookie, body: { password: PASSWORD, code: A.owner.recovery[0] } })).status, 403)
})

test('an owner resets an admin\'s second factor: their sessions end and they set it up again', { skip }, async () => {
  const a = await signIn(A.admin.email)
  await enroll(a.cookie, A.admin)
  const pw = await signIn(A.owner.email)
  const owner = await call('session/mfa', 'POST', { body: { challenge: pw.body.challenge, code: await freshCode(A.owner.secret, A.owner) } })

  assert.equal((await call('users/[id]/mfa', 'DELETE', { as: owner.cookie, params: { id: A.owner.id } })).status, 400, 'not one\'s own')
  const reset = await call('users/[id]/mfa', 'DELETE', { as: owner.cookie, params: { id: A.admin.id } })
  assert.equal(reset.status, 200)
  assert.equal((await call('users', 'GET', { as: a.cookie })).status, 401, 'the admin\'s session ended')
  const again = await signIn(A.admin.email)
  assert.equal(again.body.mfa_enrollment_required, true)
  const [u] = await sql('SELECT totp_enabled_at, (SELECT count(*)::int FROM user_recovery_codes WHERE user_id = $1) AS codes FROM users WHERE id = $1', [A.admin.id])
  assert.equal(u.totp_enabled_at, null)
  assert.equal(u.codes, 0)
})

test('guesses from inside a session count like sign-in attempts', { skip }, async () => {
  const B = await org()
  const r = await signIn(B.auditor.email)
  for (let i = 0; i < 10; i++) {
    const wrong = await call('session/mfa/setup', 'POST', { as: r.cookie, body: { password: `wrong password ${i}` } })
    assert.equal(wrong.status, 403)
  }
  // Locked: even the right password is not checked, and signing in fails too.
  const locked = await call('session/mfa/setup', 'POST', { as: r.cookie, body: { password: PASSWORD } })
  assert.equal(locked.status, 429)
  assert.equal(locked.body.error, 'locked')
  assert.equal((await signIn(B.auditor.email)).status, 401)

  // A success resets the count.
  await sql('UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = $1', [B.auditor.id])
  await call('session/mfa/setup', 'POST', { as: r.cookie, body: { password: 'wrong password' } })
  assert.equal((await call('session/mfa/setup', 'POST', { as: r.cookie, body: { password: PASSWORD } })).status, 200)
  const [u] = await sql('SELECT failed_logins FROM users WHERE id = $1', [B.auditor.id])
  assert.equal(u.failed_logins, 0)
})
