#!/usr/bin/env node
/**
 * stratum-admin — console accounts that cannot be managed from the console.
 *
 *   node scripts/stratum-admin.mjs create-owner --email ana@acme.com [--name "Ana Pérez"]
 *                                               [--org-id <uuid> | --org-name "Acme"]
 *   node scripts/stratum-admin.mjs reset-password --email ana@acme.com
 *   node scripts/stratum-admin.mjs reset-mfa --email ana@acme.com
 *   node scripts/stratum-admin.mjs enroll-mfa --email ana@acme.com [--secret-stdin]
 *   node scripts/stratum-admin.mjs catalog-update [--file models.json | --url https://...]
 *   node scripts/stratum-admin.mjs org-list
 *   node scripts/stratum-admin.mjs org-suspend --org-id <uuid> --reason "..."
 *   node scripts/stratum-admin.mjs org-resume --org-id <uuid> --reason "..."
 *   node scripts/stratum-admin.mjs org-limits --org-id <uuid> [--plan "Empresa"] [--people 25] [--agents 10]
 *                                             [--teams 5] [--gateways 2] [--monthly-tokens 50000000]
 *                                             [--monthly-budget-usd 1500] [--retention-days 90]
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
 * org-suspend stops an organization (ADR-0020): nobody of it can sign in to
 * the console, and every gateway refuses its requests (403 org_suspended)
 * within one sync interval. Nothing is deleted; org-resume undoes it. Both
 * need a reason, which the organization's audit log keeps.
 *
 * org-limits shows and sets the limits of an organization's plan (ADR-0020,
 * migration 046). Without a limit it shows each one with what the
 * organization has; with any, it changes those and keeps the rest. "none"
 * removes one (or the plan's name). People, agents, teams and gateways stop
 * the organization from adding more; lowering one never removes anything.
 * Monthly tokens and budget are for every team together, enforced by
 * gateways from 1.0 within one sync interval. Retention (31 days or more)
 * deletes older requests in the daily maintenance.
 *
 * catalog-update applies the model catalog feed now (ADR-0012): from
 * STRATUM_MODEL_CATALOG_URL or the default feed, a URL, or a local file for
 * installations without internet access (the repository's
 * catalog/models.json).
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
const feed = await import('../lib/model-feed.js')
const orgLimits = await import('../lib/org-limits.js')

const USAGE = 'usage: stratum-admin create-owner --email <email> [--name <name>] [--org-id <uuid> | --org-name <name>] [--password-stdin]\n' +
              '       stratum-admin reset-password --email <email> [--password-stdin]\n' +
              '       stratum-admin reset-mfa --email <email>\n' +
              '       stratum-admin enroll-mfa --email <email> [--secret-stdin]\n' +
              '       stratum-admin catalog-update [--file <models.json> | --url <https://...>]\n' +
              '       stratum-admin org-list\n' +
              '       stratum-admin org-suspend --org-id <uuid> --reason <text>\n' +
              '       stratum-admin org-resume --org-id <uuid> --reason <text>\n' +
              '       stratum-admin org-limits --org-id <uuid> [--plan <name>] [--people <n>] [--agents <n>] [--teams <n>]\n' +
              '                                [--gateways <n>] [--monthly-tokens <n>] [--monthly-budget-usd <n>] [--retention-days <n>]\n' +
              '                                (any of them "none" to remove it)'

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

async function audit(db, orgId, action, targetId, details, targetType = 'user') {
  await db.query(
    `INSERT INTO audit_log (org_id, actor_label, action, target_type, target_id, result, details)
     VALUES ($1, 'stratum-admin (CLI)', $2, $5, $3, 'ok', $4)`,
    [orgId, action, targetId, JSON.stringify(details), targetType])
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

async function catalogUpdate(db, opts) {
  if (opts.file && opts.url) throw new Error('Use --file or --url, not both.')
  if (opts.file) {
    const { readFile } = await import('node:fs/promises')
    let json
    try {
      json = JSON.parse(await readFile(opts.file, 'utf8'))
    } catch (err) {
      throw new Error(`${opts.file}: ${err.message}`)
    }
    const parsed = feed.parseFeed(json) // throws FeedError naming the problem
    const r = await feed.applyFeed(db, parsed, { source: `file:${opts.file}` })
    console.log(r.applied ? `Catalog of ${parsed.updated}: ${r.changed} of ${r.models} models changed.` : 'Another control plane is applying the catalog now; nothing done.')
    return
  }
  const url = opts.url ?? feed.feedUrl() ?? feed.DEFAULT_FEED_URL
  const r = await feed.refreshCatalog(db, { url })
  if (!r.ok) throw new Error(`Catalog not updated: ${r.message}`)
  console.log(r.applied ? `Catalog from ${url}: ${r.changed} of ${r.models} models changed.` : 'Another control plane is applying the catalog now; nothing done.')
}

async function orgList(db) {
  const { rows } = await db.query(`
    SELECT o.id, o.name, o.status, o.plan_name,
           (SELECT count(*) FROM users u WHERE u.org_id = o.id AND COALESCE(u.is_active, true)) AS people
      FROM organizations o ORDER BY o.created_at`)
  if (!rows.length) return console.log('There are no organizations; create one with create-owner --org-name.')
  for (const o of rows) {
    console.log(`${o.id}  ${o.status.padEnd(9)}  ${String(o.people).padStart(4)} people  ${o.name}${o.plan_name ? `  (plan: ${o.plan_name})` : ''}`)
  }
}

// Shows or changes an organization's plan limits (ADR-0020). The option
// names are the limits' with dashes: --monthly-tokens is monthly_tokens.
async function orgLimitsCommand(db, opts) {
  if (!opts['org-id']) throw new Error('--org-id is required (org-list shows them).')
  const changes = {}
  for (const key of Object.keys(orgLimits.LIMITS)) {
    const v = opts[key.replaceAll('_', '-')]
    if (v !== undefined) changes[key] = v === 'none' ? null : v
  }
  for (const k of Object.keys(opts)) {
    if (k !== 'org-id' && k !== 'plan' && !(k.replaceAll('-', '_') in orgLimits.LIMITS)) throw new Error(USAGE)
  }
  const plan = opts.plan === undefined ? undefined : (opts.plan === 'none' ? null : opts.plan.trim().slice(0, 100) || null)

  await db.query('BEGIN')
  let org
  try {
    const { rows } = await db.query('SELECT id, name, limits, plan_name FROM organizations WHERE id = $1 FOR UPDATE', [opts['org-id']])
    if (!rows[0]) throw new Error(`No organization with id ${opts['org-id']}.`)
    org = rows[0]
    if (Object.keys(changes).length || plan !== undefined) {
      const limits = orgLimits.mergeLimits(org.limits, changes)
      const planName = plan === undefined ? org.plan_name : plan
      await db.query('UPDATE organizations SET limits = $2, plan_name = $3 WHERE id = $1', [org.id, limits, planName])
      // The organization sees in its audit log what changed in its plan.
      await audit(db, org.id, 'org.limits', org.id,
        { plan: { from: org.plan_name, to: planName }, limits: { from: org.limits, to: limits } }, 'organization')
      org = { ...org, limits, plan_name: planName }
    }
    await db.query('COMMIT')
  } catch (err) {
    await db.query('ROLLBACK').catch(() => {})
    throw err
  }

  const have = await orgLimits.countAll(db, org.id)
  console.log(`${org.name}${org.plan_name ? ` — plan ${org.plan_name}` : ' — no plan name'}`)
  for (const key of Object.keys(orgLimits.LIMITS)) {
    const max = org.limits[key]
    const now = have[key] !== undefined ? `${have[key]} of ` : ''
    console.log(`  ${key.padEnd(19)} ${max == null ? `${have[key] ?? '-'} (no limit)` : `${now}${max}`}`)
  }
  for (const key of ['people', 'agents', 'teams', 'gateways']) {
    if (org.limits[key] != null && have[key] > org.limits[key]) {
      console.log(`Note: it has more ${key} than the plan allows. Nothing is removed; it cannot add more until it is under the limit.`)
    }
  }
}

// Suspends or resumes an organization (ADR-0020). Gateways read the state
// with every sync; the console's sessions check it on every request.
async function orgStatus(db, opts, status) {
  if (!opts['org-id']) throw new Error('--org-id is required (org-list shows them).')
  const reason = (opts.reason ?? '').trim()
  if (reason.length < 5) throw new Error('--reason is required: at least 5 characters, kept in the audit log.')
  await db.query('BEGIN')
  try {
    const { rows } = await db.query('SELECT id, name, status FROM organizations WHERE id = $1 FOR UPDATE', [opts['org-id']])
    if (!rows[0]) throw new Error(`No organization with id ${opts['org-id']}.`)
    if (rows[0].status === status) {
      await db.query('ROLLBACK')
      return console.log(`${rows[0].name} is already ${status}; nothing done.`)
    }
    await db.query('UPDATE organizations SET status = $2 WHERE id = $1', [rows[0].id, status])
    await audit(db, rows[0].id, status === 'suspended' ? 'org.suspend' : 'org.resume', rows[0].id, { reason }, 'organization')
    await db.query('COMMIT')
  } catch (err) {
    await db.query('ROLLBACK').catch(() => {})
    throw err
  }
  console.log(status === 'suspended'
    ? 'Suspended. Nobody of it can sign in to the console, and gateways refuse its requests from their next sync.'
    : 'Active again. Gateways take its requests from their next sync.')
}

async function main() {
  const { command, opts } = parseArgs(process.argv.slice(2))
  if (!['create-owner', 'reset-password', 'reset-mfa', 'enroll-mfa', 'catalog-update', 'org-list', 'org-suspend', 'org-resume', 'org-limits'].includes(command)) throw new Error(USAGE)
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set.')
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL })
  await db.connect()
  try {
    if (command === 'create-owner') await createOwner(db, opts)
    else if (command === 'reset-password') await resetPassword(db, opts)
    else if (command === 'reset-mfa') await resetMfa(db, opts)
    else if (command === 'enroll-mfa') await enrollMfa(db, opts)
    else if (command === 'catalog-update') await catalogUpdate(db, opts)
    else if (command === 'org-list') await orgList(db)
    else if (command === 'org-suspend') await orgStatus(db, opts, 'suspended')
    else if (command === 'org-resume') await orgStatus(db, opts, 'active')
    else if (command === 'org-limits') await orgLimitsCommand(db, opts)
    else throw new Error(USAGE)
  } finally {
    await db.end()
  }
}

main().catch(err => {
  console.error(err.message)
  process.exit(1)
})
