/**
 * instrumentation.js — runs once when the control plane server starts
 * (Next.js). Keeps request_logs' monthly partitions created two years ahead
 * (migration 019): now and every 24 hours. Failures are logged, never fatal:
 * the default partition still takes the rows. Also keeps the model catalog
 * current from its feed.
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

  // The model catalog feed (lib/model-feed.js, ADR-0012): a minute after the
  // start, then every 24 hours. A failure keeps the catalog as it was and is
  // shown in the console's Modelos page.
  const { refreshCatalog, feedUrl } = await import('./lib/model-feed.js')
  if (feedUrl()) {
    const refresh = async () => {
      const r = await refreshCatalog(getDb())
      if (r.ok && r.changed > 0) console.log(`[catalog] ${r.changed} of ${r.models} models changed`)
      if (!r.ok) console.error(`[catalog] model catalog not updated: ${r.message}`)
    }
    setTimeout(refresh, 60 * 1000).unref()
    setInterval(refresh, 24 * 60 * 60 * 1000).unref()
  }
}
