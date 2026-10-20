/**
 * Gateway software versions, from the User-Agent of their syncs
 * ("stratum-gateway/v0.2.0"). Shared by the sync route (to record them) and
 * the console pages (to show them and warn about old ones), so it has no
 * server-only imports.
 */

// A version seen in a sync this recently counts as running.
export const RECENT_MINUTES = 15

const UA_RE = /^stratum-gateway\/v?([0-9A-Za-z][0-9A-Za-z.+-]{0,39})(?:\s|$)/

/** "0.2.0", "dev", ... or null when the User-Agent is not a Stratum gateway's. */
export function gatewayVersion(userAgent) {
  const m = UA_RE.exec(String(userAgent ?? ''))
  return m ? m[1] : null
}

function parse(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(v ?? ''))
  return m ? m.slice(1, 4).map(Number) : null
}

/** a < b for release versions; false when either is not one ("dev"). */
export function olderThan(a, b) {
  const x = parse(a), y = parse(b)
  if (!x || !y) return false
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i]
  return false
}

// Features the gateways enforce, and the first release that does.
export const MODEL_SWITCH_SINCE = '0.2.0'

/** True for a release before the one that refuses models turned off in Modelos. */
export const ignoresModelSwitch = v => olderThan(v, MODEL_SWITCH_SINCE)
