/**
 * instrumentation.js — runs once when the control plane server starts
 * (Next.js). Keeps request_logs' monthly partitions created two years ahead
 * (migration 019): now and every 24 hours. Failures are logged, never fatal:
 * the default partition still takes the rows.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs' || !process.env.DATABASE_URL) return
  const { getDb } = await import('./lib/db.js')
  const ensure = async () => {
    try {
      const { rows } = await getDb().query('SELECT stratum_ensure_request_log_partitions(24) AS created')
      if (rows[0]?.created > 0) console.log(`[partitions] created ${rows[0].created} request_logs partitions`)
    } catch (err) {
      console.error(`[partitions] could not create request_logs partitions: ${err.message}`)
    }
  }
  ensure() // not awaited: a slow database must not hold up the server start
  setInterval(ensure, 24 * 60 * 60 * 1000).unref()
}
