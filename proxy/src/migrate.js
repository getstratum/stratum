#!/usr/bin/env node
/**
 * Stratum — Auto migration runner
 *
 * Runs every SQL file in db/ in alphabetical order.
 * All migrations are idempotent (IF NOT EXISTS, ON CONFLICT DO NOTHING)
 * so this is safe to run multiple times and on existing databases.
 *
 * Usage:
 *   # From project root (requires DATABASE_URL in env):
 *   node scripts/migrate.js
 *
 *   # Inside the proxy container:
 *   docker exec -it $(docker compose ps -q proxy) node /app/src/../../../scripts/migrate.js
 *
 *   # Or add to docker-compose as a one-shot service (see docs/en/deployment.md)
 */

import { readdir, readFile } from 'fs/promises'
import { join, dirname }     from 'path'
import { fileURLToPath }     from 'url'
import pg                    from 'pg'

const __dir  = dirname(fileURLToPath(import.meta.url))
const DB_DIR = join(__dir, '..', 'db')

const dbUrl = process.env.DATABASE_URL
  ?? `postgresql://postgres:${process.env.POSTGRES_PASSWORD}@localhost:5432/ai_governance`

const pool = new pg.Pool({ connectionString: dbUrl, max: 1 })

console.log('\n🗄  Stratum — Migration runner')
console.log(`   DB: ${dbUrl.replace(/:[^:@]*@/, ':***@')}\n`)

try {
  const files = (await readdir(DB_DIR))
    .filter(f => f.endsWith('.sql'))
    .sort()  // alphabetical = chronological (001_, 002_, ...)

  for (const file of files) {
    const sql = await readFile(join(DB_DIR, file), 'utf8')
    try {
      await pool.query(sql)
      console.log(`  ✓  ${file}`)
    } catch (err) {
      // Some statements may fail if already partially applied — log but continue
      const msg = err.message.split('\n')[0]
      console.warn(`  ⚠  ${file}: ${msg}`)
    }
  }

  console.log('\n  Done.\n')
} catch (err) {
  console.error('\n  ✗ Migration failed:', err.message)
  process.exit(1)
} finally {
  await pool.end()
}
