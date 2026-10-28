/**
 * Formatting of impact estimates for the console (browser and server).
 * Kept apart from ./index.js so pages do not bundle the EcoLogits data.
 *
 * An estimate is shown as its middle value, with the range beside it:
 * closed models do not publish their size, so the range is the honest part.
 */

const nf = (v, digits) => Number(v).toLocaleString('es-UY', { maximumFractionDigits: digits, minimumFractionDigits: 0 })

function scaled(v, steps) {
  const n = Number(v ?? 0)
  let i = 0
  while (i < steps.length - 1 && Math.abs(n) >= steps[i + 1][0]) i++
  const [div, unit] = steps[i]
  const x = n / div
  const digits = x === 0 ? 0 : Math.abs(x) < 1 ? 3 : Math.abs(x) < 10 ? 2 : Math.abs(x) < 100 ? 1 : 0
  return `${nf(x, digits)} ${unit}`
}

/** Grams of CO2eq: g, kg or t. */
export const co2 = g => scaled(g, [[1, 'g'], [1e3, 'kg'], [1e6, 't']])
/** Energy from Wh: Wh, kWh or MWh. */
export const energy = wh => scaled(wh, [[1, 'Wh'], [1e3, 'kWh'], [1e6, 'MWh']])
/** Water from mL: mL, L or m³. */
export const water = ml => scaled(ml, [[1, 'mL'], [1e3, 'L'], [1e6, 'm³']])

export const middle = r => (r ? (Number(r.min) + Number(r.max)) / 2 : null)

/** "12,3 g (entre 10,1 y 14,5)", or the single value when min = max. */
export function withRange(r, fmt) {
  if (!r) return '—'
  const lo = Number(r.min), hi = Number(r.max)
  if (lo === hi) return fmt(lo)
  return `${fmt(middle(r))} (entre ${fmt(lo)} y ${fmt(hi)})`
}

export const METHOD_URL = 'https://github.com/getstratum/stratum/blob/main/docs/console/usage.md#environmental-impact-estimated'
