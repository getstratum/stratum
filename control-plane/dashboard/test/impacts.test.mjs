// The estimated impact of each request (lib/impacts), against the EcoLogits
// Python library on fixed cases (test/fixtures, from lib/impacts/tools).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fixtures from './fixtures/ecologits-0.11.3.json' with { type: 'json' }
import { estimate, findModel, METHOD } from '../lib/impacts/index.js'
import { VERSION } from '../lib/impacts/ecologits.js'

const close = (got, want, what) => {
  const tol = Math.max(Math.abs(want) * 1e-7, 1e-18)
  assert.ok(Math.abs(got - want) <= tol, `${what}: ${got} != ${want}`)
}

test('the port and its data are the version the fixtures came from', () => {
  assert.equal(VERSION, fixtures.ecologits)
  assert.equal(METHOD, `ecologits-${fixtures.ecologits}`)
})

test('same results as EcoLogits, in the units Stratum stores', () => {
  for (const c of fixtures.cases) {
    const r = estimate({ provider: c.provider, model: c.model, tokensOut: c.tokens_out, durationMs: c.duration_ms })
    const what = `${c.provider}/${c.model}`
    assert.ok(r, `${what}: no estimate`)
    for (const [key, unit, f] of [['energy_wh', 'energy_kwh', 1e3], ['gwp_g', 'gwp_kg', 1e3], ['water_ml', 'wcf_l', 1e3],
                                  ['pe_kj', 'pe_mj', 1e3], ['adpe_mg_sb', 'adpe_kgsb', 1e6]]) {
      close(r[key].min, c.expected[unit].min * f, `${what} ${key} min`)
      close(r[key].max, c.expected[unit].max * f, `${what} ${key} max`)
      assert.ok(r[key].min <= r[key].max, `${what} ${key} range`)
    }
  }
})

test('models are found by alias, without the date, and through a router', () => {
  assert.equal(findModel('anthropic', 'claude-haiku-4-5').model.name, 'claude-haiku-4-5-20251001')
  assert.equal(findModel('openai', 'gpt-4.1-mini-2099-01-01').model.name, 'gpt-4.1-mini')
  assert.equal(findModel('openrouter', 'anthropic/claude-sonnet-4-5').provider, 'anthropic')
  assert.equal(findModel('azure', 'gpt-4o-mini').provider, 'openai')
  assert.equal(findModel('together', 'meta-llama/meta-llama-3.1-8b-instruct').provider, 'huggingface_hub')
})

test('no estimate without a known model or without output: never a made-up zero', () => {
  assert.equal(estimate({ provider: 'ollama', model: 'mock-fast', tokensOut: 100, durationMs: 1000 }), null)
  assert.equal(estimate({ provider: 'openai', model: 'gpt-4o-mini', tokensOut: 0, durationMs: 1000 }), null)
  assert.equal(estimate({ provider: 'openai', model: '', tokensOut: 10, durationMs: 1000 }), null)
})

test('more output costs more; the electricity mix follows the provider', () => {
  const small = estimate({ provider: 'openai', model: 'gpt-4o-mini', tokensOut: 100, durationMs: 60_000 })
  const big = estimate({ provider: 'openai', model: 'gpt-4o-mini', tokensOut: 1000, durationMs: 60_000 })
  assert.ok(big.energy_wh.min > small.energy_wh.min && big.gwp_g.max > small.gwp_g.max)
  assert.equal(small.zone, 'USA')
  assert.equal(estimate({ provider: 'mistral', model: 'mistral-large-latest', tokensOut: 10, durationMs: 1000 }).zone, 'SWE')
})
