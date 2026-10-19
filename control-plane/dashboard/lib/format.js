/**
 * lib/format.js — how the console writes numbers, money and times: Spanish
 * (Uruguay) separators, "US$" for dollars, the same rules on every page.
 */

const LOCALE = 'es-UY'

/** A number with a fixed number of decimals: 1.234,5 */
export const nf = (v, digits = 0) =>
  Number(v ?? 0).toLocaleString(LOCALE, { minimumFractionDigits: digits, maximumFractionDigits: digits })

/**
 * A cost in dollars. Two decimals from one cent up; below that, two
 * significant digits, so a single request's cost still says something.
 *
 *   0 → US$ 0 · 0.0013 → US$ 0,0013 · 1.5 → US$ 1,50 · 1234.5 → US$ 1.234,50
 */
export function formatCost(usd) {
  const n = Number(usd ?? 0)
  if (!Number.isFinite(n) || n === 0) return 'US$ 0'
  if (Math.abs(n) < 0.01) return `US$ ${n.toLocaleString(LOCALE, { maximumSignificantDigits: 2 })}`
  return `US$ ${nf(n, 2)}`
}

/** For tight spaces (chart axes): no decimals from US$ 10 up. */
export function formatCostCompact(usd) {
  const n = Number(usd ?? 0)
  if (!Number.isFinite(n) || n === 0) return 'US$ 0'
  if (n >= 10) return `US$ ${nf(n)}`
  return formatCost(n)
}

/** Tokens: 950 · 62,2 k · 500 k · 1,3 M */
export function formatTokens(v) {
  const n = Number(v ?? 0)
  const short = x => x.toLocaleString(LOCALE, { maximumFractionDigits: 1 })
  if (n >= 1e6) return `${short(n / 1e6)} M`
  if (n >= 1e3) return `${short(n / 1e3)} k`
  return nf(n)
}

/** A duration in milliseconds: 820 ms · 2,3 s */
export const formatMs = v => (v == null ? '—' : v >= 1000 ? `${nf(v / 1000, 1)} s` : `${nf(v)} ms`)

/** Date and time, short: 18 oct., 23:23 (with seconds when asked) */
export function formatDateTime(v, { seconds = false } = {}) {
  if (!v) return '—'
  return new Date(v).toLocaleString(LOCALE, {
    day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', ...(seconds ? { second: '2-digit' } : {}), hour12: false,
  })
}

/** Relative time for recent events: recién · hace 5 min · hace 3 h · 12 oct. */
export function formatAgo(t) {
  if (!t) return '—'
  const s = (Date.now() - new Date(t).getTime()) / 1000
  if (s < 90) return 'recién'
  if (s < 3600) return `hace ${Math.round(s / 60)} min`
  if (s < 86400) return `hace ${Math.round(s / 3600)} h`
  return new Date(t).toLocaleDateString(LOCALE, { day: 'numeric', month: 'short' })
}
