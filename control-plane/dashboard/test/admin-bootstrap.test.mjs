// stratum-admin bootstrap (ADR-0022): the first run of an installation,
// safe to run again, against PostgreSQL.
//
//   DATABASE_URL=postgres://... node --import ./test/register.mjs --test test/
//
// Skipped without DATABASE_URL.

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { promisify } from 'node:util'
import pg from 'pg'

const url = process.env.DATABASE_URL
const skip = url ? false : 'DATABASE_URL not set'
const run = promisify(execFile)
const NAME = `Bootstrap ${randomBytes(4).toString('hex')}`
const pool = url ? new pg.Pool({ connectionString: url, max: 2 }) : null
after(async () => {
  if (!pool) return
  await pool.query('DELETE FROM organizations WHERE name LIKE $1', [`${NAME}%`])
  await pool.end()
})

const gw = { STRATUM_GATEWAY_INSTANCE_ID: `dp_${randomBytes(16).toString('hex')}`, STRATUM_GATEWAY_SYNC_TOKEN: `dp_sync_${randomBytes(32).toString('hex')}` }
const admin = (args, env = {}) => run('node', ['scripts/stratum-admin.mjs', 'bootstrap', ...args], {
  env: { ...process.env, STRATUM_ENCRYPTION_KEY: randomBytes(32).toString('hex'), ...env },
}).then(r => r.stdout, e => { throw new Error(e.stderr || e.message) })
const email = `owner-${randomBytes(3).toString('hex')}@bootstrap.test`

test('bootstrap: the organization, its Owner and the gateway, once', { skip }, async () => {
  const first = await admin(['--org-name', NAME, '--owner-email', email, '--gateway-name', 'k8s'], gw)
  assert.match(first, /Owner .* created\. Password \(shown once\): \S{20,}/)
  assert.match(first, /: registered\./)
  const { rows: [o] } = await pool.query('SELECT id FROM organizations WHERE name = $1', [NAME])
  const { rows: [i] } = await pool.query('SELECT org_id, name FROM data_plane_instances WHERE id = $1', [gw.STRATUM_GATEWAY_INSTANCE_ID])
  assert.deepEqual([i.org_id, i.name], [o.id, 'k8s'])

  // Again: nothing changes, no password is printed.
  const again = await admin(['--org-name', NAME, '--owner-email', email], gw)
  assert.match(again, /already has an Owner/)
  assert.match(again, /already registered/)
  assert.doesNotMatch(again, /Password/)
  const { rows: [{ n }] } = await pool.query('SELECT count(*)::int AS n FROM organizations WHERE name = $1', [NAME])
  assert.equal(n, 1)

  // A new token in the installation's Secret: the gateway follows it.
  const token = `dp_sync_${randomBytes(32).toString('hex')}`
  assert.match(await admin(['--org-name', NAME], { ...gw, STRATUM_GATEWAY_SYNC_TOKEN: token }), /token changed/)
})

test('bootstrap: refuses another organization\'s gateway and malformed credentials', { skip }, async () => {
  await assert.rejects(admin(['--org-name', `${NAME} other`], gw), /belongs to another organization/)
  await assert.rejects(admin(['--org-name', `${NAME} x`], { ...gw, STRATUM_GATEWAY_SYNC_TOKEN: 'short' }), /dp_sync_ and 64 hex/)
  await assert.rejects(admin(['--org-name', `${NAME} x`], { STRATUM_GATEWAY_INSTANCE_ID: gw.STRATUM_GATEWAY_INSTANCE_ID }), /go together/)
})

test('bootstrap --spec: a team with no models, an agent that acts for people, an application and a service token, kept as said', { skip }, async () => {
  const name = `${NAME} spec`
  const id = (await import('node:crypto')).randomUUID()
  const app = `app_${randomBytes(12).toString('hex')}`
  const env = {
    PORTAL_KEY: `aig_agt_${randomBytes(24).toString('hex')}`,
    PORTAL_SECRET: `stsec_${randomBytes(32).toString('hex')}`,
    CONSOLE_TOKEN: `stsvc_${randomBytes(24).toString('hex')}`,
  }
  const spec = (uris) => JSON.stringify({
    teams: [{ name: 'Aplicaciones' }],
    agents: [{ id, name: 'portal', team: 'Aplicaciones', keyEnv: 'PORTAL_KEY', delegates: true }],
    apps: [{ id: app, name: 'Portal', secretEnv: 'PORTAL_SECRET', redirectUris: uris, usageReports: true }],
    serviceTokens: [{ name: 'Stratum Enterprise', tokenEnv: 'CONSOLE_TOKEN', scopes: ['users.read', 'providers.read'] }],
  })
  const first = await admin(['--org-name', name], { ...env, STRATUM_BOOTSTRAP_SPEC: spec(['https://portal.example.com/api/auth/callback']) })
  for (const want of [/Team Aplicaciones: made/, /Agent portal: made/, /Application Portal: registered/, /Service token Stratum Enterprise: made/]) {
    assert.match(first, want)
  }
  const { rows: [o] } = await pool.query('SELECT id FROM organizations WHERE name = $1', [name])
  const { rows: [pol] } = await pool.query(
    `SELECT p.allowed_models, p.allow_all_models FROM teams t JOIN policies p ON p.id = t.policy_id WHERE t.org_id = $1 AND t.name = 'Aplicaciones'`, [o.id])
  assert.deepEqual([pol.allowed_models, pol.allow_all_models], [[], false])
  const { rows: [ag] } = await pool.query('SELECT delegates, team_id IS NOT NULL AS has_team FROM agents WHERE id = $1', [id])
  assert.deepEqual([ag.delegates, ag.has_team], [true, true])

  // Again, the same: nothing. Another redirect URI: only that.
  const again = await admin(['--org-name', name], { ...env, STRATUM_BOOTSTRAP_SPEC: spec(['https://portal.example.com/api/auth/callback']) })
  assert.doesNotMatch(again, /Team|Agent|Application|Service token/)
  const moved = await admin(['--org-name', name], { ...env, STRATUM_BOOTSTRAP_SPEC: spec(['https://chat.example.com/api/auth/callback']) })
  assert.match(moved, /Application Portal: changed/)
  assert.doesNotMatch(moved, /Agent|Service token/)
  const { rows: [c] } = await pool.query('SELECT redirect_uris, usage_reports FROM oidc_clients WHERE id = $1', [app])
  assert.deepEqual([c.redirect_uris, c.usage_reports], [['https://chat.example.com/api/auth/callback'], true])

  // Refused before anything is written: a secret missing, an http address.
  await assert.rejects(admin(['--org-name', name], { STRATUM_BOOTSTRAP_SPEC: spec(['https://x.example.com/cb']) }), /needs PORTAL_KEY/)
  await assert.rejects(admin(['--org-name', name], { ...env, STRATUM_BOOTSTRAP_SPEC: spec(['http://x.example.com/cb']) }), /must be https/)
})
