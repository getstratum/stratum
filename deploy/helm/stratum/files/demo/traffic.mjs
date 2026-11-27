// Live requests through the demo gateway: DEMO ONLY.
//
// Runs once after setup.mjs, so the console shows today's traffic too, and
// what the gateway does with it: requests that go, a model a policy does
// not allow, an email address redacted before it reaches the provider, a
// streamed answer, labels. Every answer comes from the mock LLM.
//
// Env: STRATUM_GATEWAY_URL (default http://gateway:20128).

import { AGENTS, PEOPLE } from './setup.mjs'

const GW = process.env.STRATUM_GATEWAY_URL ?? 'http://gateway:20128'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const key = (email) => PEOPLE.find(p => p.email === email).key
const agent = (name) => AGENTS.find(a => a.name === name).key

async function chat(apiKey, model, content, { stream = false, labels } = {}) {
  const res = await fetch(`${GW}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`, 'content-type': 'application/json',
      ...(labels ? { 'x-stratum-labels': labels } : {}),
    },
    body: JSON.stringify({ model, messages: [{ role: 'user', content }], stream, max_tokens: 200 + Math.floor(Math.random() * 400) }),
  })
  await res.text()
  return res.status
}

// The gateway answers once it has synced the demo's configuration.
for (let i = 0; ; i++) {
  const status = await chat(key('dev@acme.com'), 'openai/gpt-4o-mini', 'ping').catch(() => 0)
  if (status === 200) break
  if (i === 60) throw new Error(`the gateway did not answer 200 in 2 minutes (last: ${status})`)
  await sleep(2000)
}

const plan = [
  ...Array.from({ length: 8 }, () => [key('dev@acme.com'), 'openai/gpt-4o', 'Revisá este diff y sugerí mejoras', { labels: 'feature_codigo' }]),
  ...Array.from({ length: 6 }, () => [key('ana@acme.com'), 'openai/gpt-5.4', 'Analizá la tendencia de errores de la semana', { labels: 'feature_analisis', stream: true }]),
  ...Array.from({ length: 10 }, () => [agent('bot-soporte'), 'openai/gpt-4o-mini', 'El cliente no puede iniciar sesión, ¿qué le respondo?', { labels: 'topic_soporte' }]),
  ...Array.from({ length: 5 }, () => [agent('bot-soporte'), 'mistral/mistral-small-latest', 'Clasificá este ticket por urgencia', { labels: 'topic_soporte' }]),
  ...Array.from({ length: 6 }, () => [key('marketing@acme.com'), 'openai/gpt-4o-mini', 'Tres asuntos para el newsletter de noviembre', { labels: 'topic_campanas' }]),
  // Refused: Marketing's policy does not allow gpt-4o.
  [key('marketing@acme.com'), 'openai/gpt-4o', 'Escribí el texto de la landing', { labels: 'topic_campanas' }],
  // Redacted: the address never reaches the provider.
  [key('dev@acme.com'), 'openai/gpt-4o-mini', 'Mandale el informe a juana.perez@cliente.com', { labels: 'feature_codigo' }],
]
const counts = {}
for (const [k, model, content, opts] of plan) {
  const s = await chat(k, model, content, opts)
  counts[s] = (counts[s] ?? 0) + 1
}
console.log(`traffic: ${plan.length} requests through the gateway, by status: ${JSON.stringify(counts)}`)
console.log('The console shows them within a few seconds (Consumo, Logs).')
