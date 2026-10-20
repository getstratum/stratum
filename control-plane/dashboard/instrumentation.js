/**
 * instrumentation.js — runs once when the control plane server starts
 * (Next.js). Keeps request_logs' monthly partitions created two years ahead
 * (migration 019): now and every 24 hours. Failures are logged, never fatal:
 * the default partition still takes the rows. Also keeps the model catalog
 * current from its feed, and sends alerts.
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

  // Alerts (lib/alert-delivery.js): every STRATUM_ALERTS_INTERVAL_S (300 s),
  // the first round up to two minutes after the start. Replicas coordinate
  // per alert.
  const { evaluateAlerts, alertConfig } = await import('./lib/alert-delivery.js')
  const { intervalS } = alertConfig()
  if (intervalS > 0) {
    let running = false
    const round = async () => {
      if (running) return
      running = true
      try {
        const results = await evaluateAlerts(getDb())
        const sent = results.filter(r => r.sent).length
        if (sent) console.log(`[alerts] ${sent} sent`)
      } catch (err) {
        console.error(`[alerts] round failed: ${err.message}`)
      } finally {
        running = false
      }
    }
    setTimeout(round, Math.min(120, intervalS) * 1000).unref()
    setInterval(round, intervalS * 1000).unref()
  }
}
