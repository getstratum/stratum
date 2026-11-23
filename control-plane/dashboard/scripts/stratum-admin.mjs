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
 *   node scripts/stratum-admin.mjs org-create --name "Acme" [--plan "Empresa"] [--people 25 ...]
 *   node scripts/stratum-admin.mjs org-suspend --org-id <uuid> --reason "..."
 *   node scripts/stratum-admin.mjs org-resume --org-id <uuid> --reason "..."
 *   node scripts/stratum-admin.mjs org-limits --org-id <uuid> [--plan "Empresa"] [--people 25] [--agents 10]
 *                                             [--teams 5] [--gateways 2] [--monthly-tokens 50000000]
 *                                             [--monthly-budget-usd 1500] [--retention-days 90]
 *   node scripts/stratum-admin.mjs org-delete --org-id <uuid> --confirm "<its name>" --reason "..."
 *   node scripts/stratum-admin.mjs org-undelete --org-id <uuid> --reason "..."
 *   node scripts/stratum-admin.mjs org-purge
 *   node scripts/stratum-admin.mjs platform-audit [--org-id <uuid>] [--limit 50]
 *   node scripts/stratum-admin.mjs platform-token-create --name "stratum-operator" [--days 90]
 *   node scripts/stratum-admin.mjs platform-token-list
 *   node scripts/stratum-admin.mjs platform-token-revoke --id <uuid>
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
 * org-delete deletes an organization in two steps (ADR-0020): it is
 * suspended at once and kept whole for 30 days, during which org-undelete
 * puts it back as it was. Then the console's daily maintenance deletes all
 * of it, its audit log included; org-purge does that now for those whose
 * days are over. platform-audit lists what was done to organizations from
 * here, which outlives them: every org-* command that changes something
 * writes there and in the organization's own audit log.
 *
 * org-create makes an organization without people, with its plan if given
 * (the same limits as org-limits); its first Owner comes with create-owner
 * --org-id. platform-token-* manage the tokens of the platform API
 * (/api/platform, ADR-0020): it lists, creates, suspends, deletes and sets
 * the plan of organizations and reads their usage per month, and never
 * reaches inside one. Without tokens the platform API is closed.
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
const deletion = await import('../lib/org-deletion.js')
const orgAdmin = await import('../lib/org-admin.js')
const platform = await import('../lib/platform.js')
const ACTOR = 'stratum-admin (CLI)'

const USAGE = 'usage: stratum-admin create-owner --email <email> [--name <name>] [--org-id <uuid> | --org-name <name>] [--password-stdin]\n' +
              '       stratum-admin reset-password --email <email> [--password-stdin]\n' +
              '       stratum-admin reset-mfa --email <email>\n' +
              '       stratum-admin enroll-mfa --email <email> [--secret-stdin]\n' +
              '       stratum-admin catalog-update [--file <models.json> | --url <https://...>]\n' +
              '       stratum-admin org-list\n' +
              '       stratum-admin org-create --name <name> [--plan <name>] [--people <n>] ... (the limits of org-limits)\n' +
              '       stratum-admin org-suspend --org-id <uuid> --reason <text>\n' +
              '       stratum-admin org-resume --org-id <uuid> --reason <text>\n' +
              '       stratum-admin org-limits --org-id <uuid> [--plan <name>] [--people <n>] [--agents <n>] [--teams <n>]\n' +
              '                                [--gateways <n>] [--monthly-tokens <n>] [--monthly-budget-usd <n>] [--retention-days <n>]\n' +
              '                                (any of them "none" to remove it)\n' +
              '       stratum-admin org-delete --org-id <uuid> --confirm <its name> --reason <text>\n' +
              '       stratum-admin org-undelete --org-id <uuid> --reason <text>\n' +
              '       stratum-admin org-purge\n' +
              '       stratum-admin platform-audit [--org-id <uuid>] [--limit <n>]\n' +
              '       stratum-admin platform-token-create --name <name> [--days <1-365>]\n' +
              '       stratum-admin platform-token-list\n' +
              '       stratum-admin platform-token-revoke --id <uuid>'

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
    SELECT o.id, o.name, o.status, o.plan_name, o.delete_after,
           (SELECT count(*) FROM users u WHERE u.org_id = o.id AND COALESCE(u.is_active, true)) AS people
      FROM organizations o ORDER BY o.created_at`)
  if (!rows.length) return console.log('There are no organizations; create one with create-owner --org-name.')
  for (const o of rows) {
    const extra = [o.plan_name && `plan: ${o.plan_name}`, o.delete_after && `to be deleted on ${o.delete_after.toISOString().slice(0, 10)}`].filter(Boolean)
    console.log(`${o.id}  ${o.status.padEnd(9)}  ${String(o.people).padStart(4)} people  ${o.name}${extra.length ? `  (${extra.join('; ')})` : ''}`)
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
  const plan = opts.plan === undefined ? undefined : (opts.plan === 'none' ? null : opts.plan)

  let org
  if (Object.keys(changes).length || plan !== undefined) {
    const r = await orgAdmin.setPlan(db, { orgId: opts['org-id'], plan, limits: changes, actor: ACTOR })
    org = { id: r.id, name: r.name, limits: r.limits, plan_name: r.plan }
  } else {
    const o = await orgAdmin.getOrg(db, opts['org-id'])
    if (!o) throw new Error(`No organization with id ${opts['org-id']}.`)
    org = { id: o.id, name: o.name, limits: o.limits, plan_name: o.plan }
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
  const r = await orgAdmin.setStatus(db, { orgId: opts['org-id'], status, reason: opts.reason, actor: ACTOR })
  if (!r.changed) return console.log(`${r.name} is already ${status}; nothing done.`)
  console.log(status === 'suspended'
    ? 'Suspended. Nobody of it can sign in to the console, and gateways refuse its requests from their next sync.'
    : 'Active again. Gateways take its requests from their next sync.')
}

// A new organization without people (ADR-0020): its first Owner comes with
// create-owner --org-id, or by invitation.
async function orgCreate(db, opts) {
  const limits = {}
  for (const key of Object.keys(orgLimits.LIMITS)) {
    const v = opts[key.replaceAll('_', '-')]
    if (v !== undefined) limits[key] = v
  }
  for (const k of Object.keys(opts)) {
    if (k !== 'name' && k !== 'plan' && !(k.replaceAll('-', '_') in orgLimits.LIMITS)) throw new Error(USAGE)
  }
  const r = await orgAdmin.createOrg(db, { name: opts.name, plan: opts.plan, limits, actor: ACTOR })
  console.log(`Created ${r.name} (${r.id}). Its first Owner: create-owner --org-id ${r.id} --email ...`)
}

// Platform API tokens (lib/platform.js): belong to no organization.
async function platformTokenCreate(db, opts) {
  const days = opts.days === undefined ? 90 : Number(opts.days)
  const t = await platform.createPlatformToken(db, { name: opts.name, days })
  await deletion.platformAudit(db, { actor: ACTOR, action: 'platform_token.create', details: { id: t.id, name: t.name, expires_at: t.expiresAt } })
  console.log(`Platform token "${t.name}" (${t.id}), valid until ${t.expiresAt.toISOString()}. Shown once:`)
  console.log(t.raw)
}

async function platformTokenList(db) {
  const rows = await platform.listPlatformTokens(db)
  if (!rows.length) return console.log('No platform tokens: the platform API is closed.')
  for (const t of rows) {
    const state = t.revoked_at ? 'revoked' : t.expires_at < new Date() ? 'expired' : 'active'
    const used = t.last_used_at ? `last used ${t.last_used_at.toISOString()}` : 'never used'
    console.log(`${t.id}  ${state.padEnd(7)}  ${t.token_prefix}...  until ${t.expires_at.toISOString().slice(0, 10)}  ${used}  ${t.name}`)
  }
}

async function platformTokenRevoke(db, opts) {
  if (!await platform.revokePlatformToken(db, opts.id)) throw new Error(`No active platform token with id ${opts.id} (platform-token-list shows them).`)
  await deletion.platformAudit(db, { actor: ACTOR, action: 'platform_token.revoke', details: { id: opts.id } })
  console.log('Revoked: it stops working now.')
}

async function orgDelete(db, opts) {
  if (!opts['org-id']) throw new Error('--org-id is required (org-list shows them).')
  if (!opts.confirm) throw new Error('--confirm is required: the organization\'s name, as org-list shows it.')
  const r = await deletion.markForDeletion(db, { orgId: opts['org-id'], confirmName: opts.confirm, reason: opts.reason, actor: ACTOR })
  console.log(`${r.name} is suspended and will be deleted on ${r.deleteAfter.toISOString()}, with everything it has.`)
  console.log('Until then, org-undelete puts it back as it was.')
}

async function orgUndelete(db, opts) {
  if (!opts['org-id']) throw new Error('--org-id is required (org-list shows them).')
  const r = await deletion.undoDeletion(db, { orgId: opts['org-id'], reason: opts.reason, actor: ACTOR })
  console.log(`${r.name} is no longer marked for deletion; it is ${r.status} again.`)
}

async function orgPurge() {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 })
  try {
    const done = await deletion.purgeDue(pool)
    if (!done.length) return console.log('No organization is due for deletion.')
    for (const d of done) console.log(`Deleted ${d.name} (${d.orgId}): ${d.counts.people} people, ${d.counts.teams} teams, ${d.counts.agents} agents, ${d.counts.gateways} gateways.`)
  } finally {
    await pool.end()
  }
}

async function platformAuditList(db, opts) {
  const limit = Math.min(Math.max(Number(opts.limit ?? 50) || 50, 1), 1000)
  const { rows } = await db.query(
    `SELECT at, actor, action, org_id, org_name, details FROM platform_audit
      WHERE $1::uuid IS NULL OR org_id = $1 ORDER BY id DESC LIMIT $2`, [opts['org-id'] ?? null, limit])
  if (!rows.length) return console.log('Nothing yet.')
  for (const e of rows) {
    const why = e.details?.reason ? `  "${e.details.reason}"` : ''
    console.log(`${e.at.toISOString()}  ${e.action.padEnd(13)}  ${e.org_name ?? '-'} (${e.org_id ?? '-'})  by ${e.actor}${why}`)
  }
}

async function main() {
  const { command, opts } = parseArgs(process.argv.slice(2))
  if (!['create-owner', 'reset-password', 'reset-mfa', 'enroll-mfa', 'catalog-update', 'org-list', 'org-suspend', 'org-resume', 'org-limits', 'org-delete', 'org-undelete', 'org-purge', 'platform-audit', 'org-create', 'platform-token-create', 'platform-token-list', 'platform-token-revoke'].includes(command)) throw new Error(USAGE)
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
    else if (command === 'org-delete') await orgDelete(db, opts)
    else if (command === 'org-undelete') await orgUndelete(db, opts)
    else if (command === 'org-purge') await orgPurge()
    else if (command === 'platform-audit') await platformAuditList(db, opts)
    else if (command === 'org-create') await orgCreate(db, opts)
    else if (command === 'platform-token-create') await platformTokenCreate(db, opts)
    else if (command === 'platform-token-list') await platformTokenList(db)
    else if (command === 'platform-token-revoke') await platformTokenRevoke(db, opts)
    else throw new Error(USAGE)
  } finally {
    await db.end()
  }
}

main().catch(err => {
  console.error(err.message)
  process.exit(1)
})
