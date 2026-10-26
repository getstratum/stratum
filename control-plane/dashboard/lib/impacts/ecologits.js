/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/ (copy in
 * ./data/LICENSE-MPL-2.0).
 *
 * A port to JavaScript of the LLM inference model of EcoLogits 0.11.3
 * (GenAI Impact, https://github.com/mlco2/ecologits): ecologits/impacts/llm.py
 * and the provider settings of ecologits/tracers/utils.py. Same constants,
 * same steps, same units; test/impacts.test.mjs checks it against the Python
 * library on fixed cases (test/fixtures/ecologits-0.11.3.json).
 *
 * Units: parameters in billions, latency in seconds; energy in kWh, GWP in
 * kgCO2eq, ADPe in kgSbeq, PE in MJ, water (WCF) in L.
 */

export const VERSION = '0.11.3'

const MODEL_QUANTIZATION_BITS = 16

const GPU_ENERGY_ALPHA = 1.1665273170451914e-06
const GPU_ENERGY_BETA = -0.011205921025579175
const GPU_ENERGY_GAMMA = 4.052928146734005e-05

const LATENCY_ALPHA = 0.0006785088094353663
const LATENCY_BETA = 0.0003119310311688259
const LATENCY_GAMMA = 0.019473717579473387

const GPU_MEMORY = 80 // GB
const GPU_EMBODIED = { gwp: 273, adpe: 0.00895, pe: 3721 }

const SERVER_GPUS = 8
const SERVER_POWER = 1.2 // kW
const SERVER_EMBODIED = { gwp: 5700, adpe: 0.37, pe: 70000 }

const HARDWARE_LIFESPAN = 3 * 365 * 24 * 60 * 60 // s
const BATCH_SIZE = 64

/** Datacenter settings per provider (ecologits/tracers/utils.py). */
export const PROVIDERS = {
  anthropic:       { location: 'USA', pue: { min: 1.09, max: 1.14 }, wue: { min: 0.13, max: 0.999 } },
  cohere:          { location: 'USA', pue: 1.09, wue: 0.999 },
  google_genai:    { location: 'USA', pue: 1.09, wue: 0.999 },
  huggingface_hub: { location: 'USA', pue: { min: 1.09, max: 1.14 }, wue: { min: 0.13, max: 0.99 } },
  mistralai:       { location: 'SWE', pue: 1.16, wue: 0.09 },
  openai:          { location: 'USA', pue: 1.20, wue: 0.569 },
}

const lo = v => (typeof v === 'number' ? v : v.min)
const hi = v => (typeof v === 'number' ? v : v.max)

/** One pass of the DAG with scalar inputs. */
function pass({ active, total, outputTokens, requestLatency, mix, pue, wue, tps, ttft }) {
  const gpuEnergy = outputTokens * (GPU_ENERGY_ALPHA * Math.exp(GPU_ENERGY_BETA * BATCH_SIZE) * active + GPU_ENERGY_GAMMA) / 1000

  const perToken = tps == null ? LATENCY_ALPHA * active + LATENCY_BETA * BATCH_SIZE + LATENCY_GAMMA : 1 / tps
  const gpuLatency = outputTokens * perToken + (ttft || 0)
  const latency = requestLatency < gpuLatency ? requestLatency : gpuLatency

  const memory = 1.2 * total * MODEL_QUANTIZATION_BITS / 8
  const gpus = 2 ** Math.ceil(Math.log2(Math.ceil(memory / GPU_MEMORY)))

  const serverEnergy = (latency / 3600) * SERVER_POWER * (gpus / SERVER_GPUS) * (1 / BATCH_SIZE)
  const itEnergy = serverEnergy + gpus * gpuEnergy
  const energy = pue * itEnergy

  const embodied = k => (gpus / SERVER_GPUS) * SERVER_EMBODIED[k] + gpus * GPU_EMBODIED[k]
  const share = latency / (HARDWARE_LIFESPAN * BATCH_SIZE)
  return {
    energy,
    gwp: energy * mix.gwp + share * embodied('gwp'),
    adpe: energy * mix.adpe + share * embodied('adpe'),
    pe: energy * mix.pe + share * embodied('pe'),
    wcf: itEnergy * (wue + pue * mix.wue),
  }
}

/**
 * The impacts of one request, each as { min, max } (equal when every input
 * is a single value), as EcoLogits' compute_llm_impacts: the low end from
 * the low ends of parameters, PUE and WUE, the high end from the high ends.
 *
 *   active, total   parameters in billions: a number or { min, max }
 *   mix             { gwp, adpe, pe, wue } of the electricity mix
 *   pue, wue        the datacenter's: a number or { min, max }
 *   requestLatency  measured, in seconds (Infinity when unknown)
 *   tps, ttft       the model's deployment figures, when known
 */
export function llmImpacts({ active, total, outputTokens, requestLatency = Infinity, mix, pue, wue, tps = null, ttft = null }) {
  const common = { outputTokens, requestLatency, mix, tps, ttft }
  const a = pass({ ...common, active: lo(active), total: lo(total), pue: lo(pue), wue: lo(wue) })
  const b = pass({ ...common, active: hi(active), total: hi(total), pue: hi(pue), wue: hi(wue) })
  const out = {}
  for (const k of Object.keys(a)) out[k] = { min: a[k], max: b[k] }
  return out
}
