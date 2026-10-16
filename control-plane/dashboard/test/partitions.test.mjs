// request_logs partitions (migration 019): monthly partitions ahead of time,
// and a default one so an insert never fails for want of a partition.
//
//   DATABASE_URL=postgres://... node --import ./test/register.mjs --test test/
//
// Skipped without DATABASE_URL. Each test runs in a transaction it rolls back.

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'

const pg = (await import('pg')).default
const url = process.env.DATABASE_URL
const skip = url ? false : 'DATABASE_URL not set'

let client
before(async () => {
  if (skip) return
  client = new pg.Client({ connectionString: url })
  await client.connect()
})
after(async () => { await client?.end() })

async function inTransaction(fn) {
  await client.query('BEGIN')
  try { await fn() } finally { await client.query('ROLLBACK') }
}

const monthName = (offset) =>
  client.query(`SELECT 'request_logs_' || to_char(date_trunc('month', now()) + make_interval(months => $1), 'YYYY_MM') AS n`, [offset])
    .then(r => r.rows[0].n)

const exists = (name) => client.query('SELECT to_regclass($1) IS NOT NULL AS e', [name]).then(r => r.rows[0].e)

test('partitions exist from this month to 24 months ahead, plus a default one', { skip }, async () => {
  for (const offset of [0, 1, 12, 24]) assert.ok(await exists(await monthName(offset)), `month +${offset}`)
  assert.ok(await exists('request_logs_default'))
})

test('a row with no monthly partition lands in the default one', { skip }, async () => {
  await inTransaction(async () => {
    const { rows } = await client.query(
      `INSERT INTO request_logs (org_id, provider, model_id, created_at)
       VALUES ('00000000-0000-0000-0000-000000000001', 'test', 'test', '2099-06-15')
       RETURNING tableoid::regclass::text AS part`)
    assert.equal(rows[0].part, 'request_logs_default')
  })
})

test('the function creates a missing month, but not one whose rows are already in the default', { skip }, async () => {
  await inTransaction(async () => {
    const name = await monthName(24)
    await client.query(`DROP TABLE ${name}`)
    assert.equal((await client.query('SELECT stratum_ensure_request_log_partitions(24) AS n')).rows[0].n, 1)
    assert.ok(await exists(name))

    // Rows for that month in the default partition block it: warned, skipped.
    await client.query(`DROP TABLE ${name}`)
    await client.query(
      `INSERT INTO request_logs (org_id, provider, model_id, created_at)
       VALUES ('00000000-0000-0000-0000-000000000001', 'test', 'test',
               date_trunc('month', now()) + interval '24 months' + interval '3 days')`)
    const notices = []
    const onNotice = (n) => notices.push(n)
    client.on('notice', onNotice)
    try {
      assert.equal((await client.query('SELECT stratum_ensure_request_log_partitions(24) AS n')).rows[0].n, 0)
    } finally {
      client.off('notice', onNotice)
    }
    assert.ok(!(await exists(name)))
    assert.ok(notices.some(n => n.severity === 'WARNING' && n.message.includes(name)), 'a warning names the partition')
  })
})
