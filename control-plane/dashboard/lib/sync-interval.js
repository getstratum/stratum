/**
 * lib/sync-interval.js — how often gateways ask this console for their
 * configuration (STRATUM_SYNC_INTERVAL_S, 30 s by default). The sync answer
 * tells gateways; the pages say it, so what they promise is what happens.
 */

export function syncIntervalS(env = process.env) {
  const n = parseInt(env.STRATUM_SYNC_INTERVAL_S ?? '30', 10)
  return Number.isFinite(n) && n > 0 ? n : 30
}
