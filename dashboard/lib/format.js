/**
 * Formats a USD cost with enough decimal places to always be meaningful.
 *
 *   >= $1000  → 2 decimals   ($1,234.56)
 *   >= $1     → 4 decimals   ($1.2345)
 *   >= $0.01  → 6 decimals   ($0.001234)
 *   < $0.01   → 8 decimals   ($0.00000045)
 *   = 0       → 6 decimals   ($0.000000)
 */
export function formatCost(usd) {
  const n = parseFloat(usd ?? 0)
  if (n === 0)    return '$0.000000'
  if (n >= 1000)  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  if (n >= 1)     return `$${n.toFixed(4)}`
  if (n >= 0.01)  return `$${n.toFixed(6)}`
  return `$${n.toFixed(8)}`
}

/**
 * Compact cost for tight spaces (chart axes, badges).
 * Always shows at least 4 significant decimals.
 */
export function formatCostCompact(usd) {
  const n = parseFloat(usd ?? 0)
  if (n === 0)   return '$0'
  if (n >= 1)    return `$${n.toFixed(2)}`
  if (n >= 0.01) return `$${n.toFixed(4)}`
  return `$${n.toFixed(6)}`
}

/**
 * Formats token counts with K/M suffix.
 */
export function formatTokens(n) {
  const v = parseInt(n ?? 0)
  if (v === 0)        return '0'
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(3)}M`
  if (v >= 1_000)     return `${(v / 1_000).toFixed(2)}K`
  return v.toLocaleString()
}
