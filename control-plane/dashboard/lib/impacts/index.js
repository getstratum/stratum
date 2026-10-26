/**
 * lib/impacts — the estimated environmental impact of each request to a
 * model: energy, emissions (GWP), water, primary energy and abiotic
 * resource depletion, with the method of EcoLogits (./ecologits.js, MPL-2.0)
 * and its data (./data, MPL-2.0). Design: "Stratum: impacto ambiental del
 * uso de IA".
 *
 * It is an estimate, not a measurement: closed models do not publish their
 * size, so most results are a range (min, max). It uses what gateways
 * already report: provider, model, output tokens and duration.
 *
 * A model EcoLogits does not know has no estimate (null), never zero.
 */

import { llmImpacts, PROVIDERS, VERSION } from './ecologits.js'
import modelData from './data/models.json' with { type: 'json' }
import mixData from './data/electricity_mixes.json' with { type: 'json' }

/** Stored with every estimate, so later changes of method or data are told apart. */
export const METHOD = `ecologits-${VERSION}`

// Stratum's provider IDs → EcoLogits'. Azure OpenAI serves OpenAI's models,
// so it takes OpenAI's figures. A router names the lab in the model ID.
const PROVIDER_MAP = {
  openai: 'openai', azure: 'openai', anthropic: 'anthropic', gemini: 'google_genai',
  mistral: 'mistralai', cohere: 'cohere',
}
const LAB_PREFIX = {
  openai: 'openai', anthropic: 'anthropic', google: 'google_genai', mistralai: 'mistralai', cohere: 'cohere',
}

const models = new Map()      // "provider/name" → model
const openModels = new Map()  // lowercase Hugging Face name → model (open weights, any host)
for (const m of modelData.models) {
  models.set(`${m.provider}/${m.name}`, m)
  if (m.provider === 'huggingface_hub') openModels.set(m.name.toLowerCase(), m)
}
for (const a of modelData.aliases ?? []) {
  const m = models.get(`${a.provider}/${a.alias}`)
  if (m) models.set(`${a.provider}/${a.name}`, m)
}
const mixes = new Map(mixData.electricity_mixes.map(e => [e.name, e]))

const withoutDate = name => name.replace(/-(\d{4}-\d{2}-\d{2}|\d{8})$/, '')

/**
 * The EcoLogits model behind a Stratum provider and model ID, and the
 * provider whose datacenter figures apply; null when unknown.
 */
export function findModel(provider, modelId) {
  if (!modelId) return null
  let p = PROVIDER_MAP[provider]
  let name = modelId
  // "openai/gpt-4o-mini" through a router, or as a gateway logs it.
  const slash = modelId.indexOf('/')
  if (slash > 0) {
    const lab = LAB_PREFIX[modelId.slice(0, slash).toLowerCase()]
    if (lab) {
      p = lab
      name = modelId.slice(slash + 1)
    }
  }
  if (p) {
    const m = models.get(`${p}/${name}`) ?? models.get(`${p}/${withoutDate(name)}`)
    if (m) return { model: m, provider: p }
  }
  // Open weights served by anyone (Groq, Together, Ollama...): Hugging Face's
  // figures, which assume a datacenter like the labs'.
  const open = openModels.get(modelId.toLowerCase())
  return open ? { model: open, provider: 'huggingface_hub' } : null
}

const round = (v, digits = 9) => Number(v.toPrecision(digits))

/**
 * The estimate for one request, in the units request_logs stores, or null:
 *
 *   energy_wh, gwp_g (g CO2eq), water_ml, pe_kj, adpe_mg_sb — each { min, max }
 *   zone      the electricity mix used (ISO 3166-1 alpha-3, or WOR)
 *   method    METHOD
 *
 * Only for a request that produced output: no tokens, no estimate.
 */
export function estimate({ provider, model, tokensOut, durationMs }) {
  if (!(tokensOut > 0)) return null
  const found = findModel(provider, model)
  if (!found) return null
  const { model: m, provider: p } = found
  const cfg = PROVIDERS[p]
  const params = m.architecture.parameters
  const moe = m.architecture.type === 'moe'
  const zone = mixes.has(cfg.location) ? cfg.location : 'WOR'
  const r = llmImpacts({
    active: moe ? params.active : params,
    total: moe ? params.total : params,
    outputTokens: tokensOut,
    requestLatency: durationMs > 0 ? durationMs / 1000 : Infinity,
    mix: mixes.get(zone),
    pue: cfg.pue,
    wue: cfg.wue,
    tps: m.deployment?.tps ?? null,
    ttft: m.deployment?.ttft ?? null,
  })
  const scaled = (v, f) => ({ min: round(v.min * f), max: round(v.max * f) })
  return {
    energy_wh: scaled(r.energy, 1e3),   // kWh → Wh
    gwp_g: scaled(r.gwp, 1e3),          // kg → g
    water_ml: scaled(r.wcf, 1e3),       // L → mL
    pe_kj: scaled(r.pe, 1e3),           // MJ → kJ
    adpe_mg_sb: scaled(r.adpe, 1e6),    // kg → mg
    zone,
    method: METHOD,
  }
}
