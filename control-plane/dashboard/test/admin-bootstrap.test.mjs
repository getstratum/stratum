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
