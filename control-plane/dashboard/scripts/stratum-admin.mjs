#!/usr/bin/env node
/**
 * stratum-admin — console accounts that cannot be managed from the console.
 *
 *   node scripts/stratum-admin.mjs create-owner --email ana@acme.com [--name "Ana Pérez"]
 *                                               [--org-id <uuid> | --org-name "Acme"]
 *   node scripts/stratum-admin.mjs reset-password --email ana@acme.com
 *   node scripts/stratum-admin.mjs reset-mfa --email ana@acme.com
 *   node scripts/stratum-admin.mjs enroll-mfa --email ana@acme.com [--secret-stdin]
 *
 * create-owner makes (or promotes) the Owner of an organization: the first
 * account of a new installation, or a way back in when nobody can sign in.
 * With --org-name it creates that organization; with --org-id it uses an
 * existing one; with neither it uses the only organization there is.
 *
 * Both commands print a new random password once. To choose it instead (at
 * least 12 characters), pipe it in with --password-stdin, or set
 * STRATUM_ADMIN_PASSWORD.
 *
 * reset-mfa turns off someone's second factor (a lost phone, when no other
 * Owner can do it from the console); an Owner or Admin sets it up again on
 * the next sign-in. enroll-mfa sets it up without the console, for
 * automated installations: it prints the secret for the authenticator
 * (or takes one in base32 from stdin) and needs STRATUM_ENCRYPTION_KEY.
 * Recovery codes are created from the account page.
 *
 * Needs DATABASE_URL. In the control plane container:
 *   docker compose exec control-plane node scripts/stratum-admin.mjs create-owner --email ...
 */

import { randomBytes } from 'node:crypto'
import pg from 'pg'

// lib/password.js is an ES module in a package without "type": "module"
// (Next.js compiles it either way); keep Node's notice about that out of
// the output.
process.removeAllListeners('warning')
const { hashPassword, passwordProblem } = await import('../lib/password.js')
const totp = await import('../lib/totp.js')
const { encryptSecret } = await import('../lib/secrets.js')

const USAGE = 'usage: stratum-admin create-owner --email <email> [--name <name>] [--org-id <uuid> | --org-name <name>] [--password-stdin]\n' +
              '       stratum-admin reset-password --email <email> [--password-stdin]\n' +
              '       stratum-admin reset-mfa --email <email>\n' +
              '       stratum-admin enroll-mfa --email <email> [--secret-stdin]'

const FLAGS = new Set(['password-stdin', 'secret-stdin'])

function parseArgs(argv) {
  const [command, ...rest] = argv
  const opts = {}
  for (let i = 0; i < rest.length; i++) {
    if (rest[i].startsWith('--') && FLAGS.has(rest[i].slice(2))) { opts[rest[i].slice(2)] = true; continue }
    const m = /^--([a-z-]+)$/.exec(rest[i])
    if (!m || rest[i + 1] === undefined) throw new Error(USAGE)
    opts[m[1]] = rest[++i]
  }
  return { command, opts }
}

async function readStdin() {
  let data = ''
  for await (const chunk of process.stdin) data += chunk
  return data.replace(/\r?\n$/, '')
}

async function newPassword(opts) {
  const chosen = opts['password-stdin'] ? await readStdin() : process.env.STRATUM_ADMIN_PASSWORD
  if (chosen) {
    const problem = passwordProblem(chosen)
    if (problem) throw new Error(`password: ${problem}`)
    return { password: chosen, generated: false }
  }
  return { password: randomBytes(18).toString('base64url'), generated: true }
}

async function audit(db, orgId, action, targetId, details) {
  await db.query(
    `INSERT INTO audit_log (org_id, actor_label, action, target_type, target_id, result, details)
     VALUES ($1, 'stratum-admin (CLI)', $2, 'user', $3, 'ok', $4)`,
    [orgId, action, targetId, JSON.stringify(details)])
}

async function resolveOrg(db, opts) {
  if (opts['org-id'] && opts['org-name']) throw new Error('Use --org-id or --org-name, not both.')
  if (opts['org-name']) {
    const { rows } = await db.query('INSERT INTO organizations (name) VALUES ($1) RETURNING id, name', [opts['org-name']])
    return { ...rows[0], created: true }
  }
  if (opts['org-id']) {
    const { rows } = await db.query('SELECT id, name FROM organizations WHERE id = $1', [opts['org-id']])
    if (!rows[0]) throw new Error(`No organization with id ${opts['org-id']}.`)
    return rows[0]
  }
  const { rows } = await db.query('SELECT id, name FROM organizations ORDER BY created_at')
  if (rows.length === 1) return rows[0]
  const list = rows.map(o => `  ${o.id}  ${o.name}`).join('\n')
  throw new Error(rows.length
    ? `There are ${rows.length} organizations; choose one with --org-id:\n${list}`
    : 'There are no organizations; create one with --org-name.')
}

async function createOwner(db, opts) {
  const email = opts.email?.trim().toLowerCase()
  if (!email || !email.includes('@')) throw new Error(USAGE)
  const { password, generated } = await newPassword(opts)
  const hash = await hashPassword(password)

  await db.query('BEGIN')
  try {
    const org = await resolveOrg(db, opts)
    const { rows: existing } = await db.query(
      'SELECT id, org_id FROM users WHERE lower(email) = $1', [email])
    let userId
    if (existing[0]) {
      if (existing[0].org_id !== org.id) {
        throw new Error(`${email} already belongs to another organization (${existing[0].org_id}).`)
      }
      userId = existing[0].id
      await db.query(
        `UPDATE users SET role = 'owner', is_active = true, password_hash = $2,
                          failed_logins = 0, locked_until = NULL
          WHERE id = $1`, [userId, hash])
      await db.query('UPDATE console_sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [userId])
    } else {
      const { rows } = await db.query(
        `INSERT INTO users (org_id, email, name, role, password_hash)
         VALUES ($1, $2, $3, 'owner', $4) RETURNING id`,
        [org.id, email, opts.name ?? email.split('@')[0], hash])
      userId = rows[0].id
    }
    await audit(db, org.id, 'owner.bootstrap', userId, { email, orgCreated: !!org.created, existed: !!existing[0] })
    await db.query('COMMIT')

    console.log(`Owner ${email} of "${org.name}" (${org.id}) is ready.`)
    if (generated) console.log(`Password (shown once): ${password}`)
  } catch (err) {
    await db.query('ROLLBACK')
    throw err
  }
}

async function resetPassword(db, opts) {
  const email = opts.email?.trim().toLowerCase()
  if (!email) throw new Error(USAGE)
  const { password, generated } = await newPassword(opts)
  const { rows } = await db.query(
    `UPDATE users SET password_hash = $2, failed_logins = 0, locked_until = NULL
      WHERE lower(email) = $1 RETURNING id, org_id`,
    [email, await hashPassword(password)])
  if (!rows[0]) throw new Error(`No account with email ${email}.`)
  await db.query('UPDATE console_sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [rows[0].id])
  await audit(db, rows[0].org_id, 'user.password.reset', rows[0].id, { email })
  console.log(`Password of ${email} replaced; their console sessions were closed.`)
  if (generated) console.log(`Password (shown once): ${password}`)
}

async function findUser(db, opts) {
  const email = opts.email?.trim().toLowerCase()
  if (!email) throw new Error(USAGE)
  const { rows } = await db.query('SELECT id, org_id, email FROM users WHERE lower(email) = $1', [email])
  if (!rows[0]) throw new Error(`No account with email ${email}.`)
  return rows[0]
}

async function resetMfa(db, opts) {
  const u = await findUser(db, opts)
  await db.query(
    `UPDATE users SET totp_secret_encrypted = NULL, totp_pending_secret_encrypted = NULL, totp_enabled_at = NULL
      WHERE id = $1`, [u.id])
  await db.query('DELETE FROM user_recovery_codes WHERE user_id = $1', [u.id])
  await db.query('DELETE FROM console_login_challenges WHERE user_id = $1', [u.id])
  await db.query('UPDATE console_sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [u.id])
  await audit(db, u.org_id, 'user.mfa.reset', u.id, { email: u.email })
  console.log(`Second factor of ${u.email} turned off; their console sessions were closed.`)
}

async function enrollMfa(db, opts) {
  const u = await findUser(db, opts)
  let secret
  if (opts['secret-stdin']) {
    secret = (await readStdin()).trim().toUpperCase().replace(/[\s=]/g, '')
    if (!/^[A-Z2-7]{26,}$/.test(secret)) throw new Error('secret: base32, at least 128 bits (26 characters).')
  } else {
    secret = totp.newSecret()
  }
  await db.query(
    `UPDATE users SET totp_secret_encrypted = $2, totp_pending_secret_encrypted = NULL,
                      totp_enabled_at = now(), totp_last_step = 0
      WHERE id = $1`, [u.id, encryptSecret(secret)])
  await db.query('DELETE FROM user_recovery_codes WHERE user_id = $1', [u.id])
  await db.query('UPDATE console_sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [u.id])
  await audit(db, u.org_id, 'mfa.enable', u.id, { email: u.email, by: 'cli' })
  console.log(`Second factor of ${u.email} is on.`)
  if (!opts['secret-stdin']) {
    console.log(`Secret for the authenticator (shown once): ${secret}`)
    console.log(`URI: ${totp.otpauthUri({ secret, account: u.email })}`)
  }
}

async function main() {
  const { command, opts } = parseArgs(process.argv.slice(2))
  if (!['create-owner', 'reset-password', 'reset-mfa', 'enroll-mfa'].includes(command)) throw new Error(USAGE)
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set.')
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL })
  await db.connect()
  try {
    if (command === 'create-owner') await createOwner(db, opts)
    else if (command === 'reset-password') await resetPassword(db, opts)
    else if (command === 'reset-mfa') await resetMfa(db, opts)
    else if (command === 'enroll-mfa') await enrollMfa(db, opts)
    else throw new Error(USAGE)
  } finally {
    await db.end()
  }
}

main().catch(err => {
  console.error(err.message)
  process.exit(1)
})
