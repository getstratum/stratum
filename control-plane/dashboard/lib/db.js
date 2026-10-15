import pg from 'pg'

const { Pool } = pg

// Singleton pool — reused across all server component renders
let pool

export function getDb() {
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 5,
      idleTimeoutMillis: 30_000,
    })
  }
  return pool
}

// Convenience wrapper
export async function query(sql, params = []) {
  const db = getDb()
  const { rows } = await db.query(sql, params)
  return rows
}

// Closes the pool (tests and scripts; the server keeps it for its lifetime).
export async function closeDb() {
  if (pool) {
    const p = pool
    pool = undefined
    await p.end()
  }
}
