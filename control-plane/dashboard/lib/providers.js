/**
 * lib/providers.js — the providers the console offers, matching what the
 * gateway knows how to call (gateway/internal/provider).
 *
 * A gateway addresses a provider by its name ("anthropic", "openai", ...):
 * clients send "model": "<provider>/<model>". The name sets the wire protocol
 * (Anthropic Messages, Azure OpenAI, or OpenAI-compatible for everything
 * else) and, unless the configuration has a base URL, the address.
 *
 * Custom providers are any OpenAI-compatible endpoint (vLLM, Ollama,
 * LiteLLM, an internal service), named "custom-<name>".
 *
 * Besides the presets the gateway knows by name, the catalog
 * (lib/provider-catalog.js) offers other OpenAI-compatible providers. The
 * gateway does not know their addresses, so their configuration always
 * stores the address (stored: true).
 */

import { badRequest } from './route.js'
import { CATALOG } from './provider-catalog.js'

// base:     the gateway's default address (null: the configuration must give one)
// models:   path that lists models, for the connection test (null: no test)
// key:      whether a credential is required
// category: lab | inference | cloud | regional | router | self (how the console groups them)
// free:     the provider offers a free tier (as listed by the catalog; it changes)
// docs:     where to get a key
export const PRESETS = {
  anthropic:  { label: 'Anthropic',     protocol: 'anthropic', base: 'https://api.anthropic.com',                                models: '/v1/models?limit=1000', key: true, category: 'lab',       free: false, docs: 'https://console.anthropic.com/settings/keys' },
  openai:     { label: 'OpenAI',        protocol: 'openai',    base: 'https://api.openai.com',                                   models: '/v1/models', key: true,  category: 'lab',       free: false, docs: 'https://platform.openai.com/api-keys' },
  gemini:     { label: 'Google Gemini', protocol: 'openai',    base: 'https://generativelanguage.googleapis.com/v1beta/openai', models: '/models',    key: true,  category: 'lab',       free: true,  docs: 'https://aistudio.google.com/apikey' },
  mistral:    { label: 'Mistral',       protocol: 'openai',    base: 'https://api.mistral.ai',                                   models: '/v1/models', key: true,  category: 'lab',       free: true,  docs: 'https://console.mistral.ai/api-keys' },
  groq:       { label: 'Groq',          protocol: 'openai',    base: 'https://api.groq.com/openai',                              models: '/v1/models', key: true,  category: 'inference', free: true,  docs: 'https://console.groq.com/keys' },
  deepseek:   { label: 'DeepSeek',      protocol: 'openai',    base: 'https://api.deepseek.com',                                 models: '/models',    key: true,  category: 'regional',  free: false, docs: 'https://platform.deepseek.com/api_keys' },
  openrouter: { label: 'OpenRouter',    protocol: 'openai',    base: 'https://openrouter.ai/api',                                models: '/v1/models', key: true,  category: 'router',    free: true,  docs: 'https://openrouter.ai/settings/keys' },
  xai:        { label: 'xAI',           protocol: 'openai',    base: 'https://api.x.ai',                                         models: '/v1/models', key: true,  category: 'lab',       free: false, docs: 'https://console.x.ai' },
  together:   { label: 'Together AI',   protocol: 'openai',    base: 'https://api.together.xyz',                                 models: '/v1/models', key: true,  category: 'inference', free: false, docs: 'https://api.together.ai/settings/api-keys' },
  azure:      { label: 'Azure OpenAI',  protocol: 'azure',     base: null,                                                       models: null,         key: true,  category: 'cloud',     free: false, docs: null },
  ollama:     { label: 'Ollama',        protocol: 'openai',    base: null,                                                       models: null,         key: false, category: 'self',      free: false, docs: null },
}

// Every provider the console offers by name: the catalog, with the presets
// above taking precedence over a catalog entry of the same name.
export const PROVIDERS = Object.freeze({
  ...Object.fromEntries(CATALOG.filter(e => !Object.hasOwn(PRESETS, e.id)).map(e => [e.id, {
    label: e.label, protocol: 'openai', base: e.base, models: '/models', key: true,
    category: e.category, free: e.free, docs: e.docs, stored: true,
  }])),
  ...PRESETS,
})

export const CUSTOM_RE = /^custom-[a-z0-9][a-z0-9-]{0,38}$/

/** The preset for `provider`, a custom provider's description, or null. */
export function describe(provider) {
  if (typeof provider !== 'string') return null
  if (Object.hasOwn(PROVIDERS, provider)) return { ...PROVIDERS[provider], custom: false }
  if (CUSTOM_RE.test(provider)) return { label: 'Custom', protocol: 'openai', base: null, models: null, key: false, custom: true }
  return null
}

/** The provider name in a request, validated. */
export function providerName(value) {
  if (typeof value !== 'string' || !describe(value)) {
    throw badRequest('Proveedor desconocido: elegí uno de la lista, o custom-<nombre> para un endpoint compatible con OpenAI.')
  }
  return value
}

/**
 * A base URL in a request, validated, or null (use the provider's default).
 * Presets talk to the public internet, so only https; Ollama and custom
 * endpoints may be internal plain-HTTP addresses (gateways call them, the
 * control plane does not).
 */
export function baseUrl(value, info) {
  if (value == null || value === '') {
    if (!info.base) throw badRequest('Este proveedor necesita una URL base.')
    // A catalog provider's address travels to gateways, which do not know it.
    return info.stored ? info.base : null
  }
  let u
  try {
    u = new URL(value)
  } catch {
    throw badRequest('URL base inválida.')
  }
  const internalOk = info.custom || info.base === null
  if (u.protocol !== 'https:' && !(internalOk && u.protocol === 'http:')) {
    throw badRequest(internalOk ? 'La URL base tiene que ser http(s).' : 'La URL base tiene que ser https.')
  }
  if (u.username || u.password || u.search || u.hash) {
    throw badRequest('La URL base no puede llevar credenciales, parámetros (?…) ni fragmento (#…).')
  }
  return value.replace(/\/+$/, '')
}

/** Azure needs the API version; nothing else is accepted in extra_config. */
export function extraConfig(value, provider) {
  if (provider !== 'azure') return {}
  const v = value?.api_version
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}(-preview)?$/.test(v)) {
    throw badRequest('Azure necesita api_version (por ejemplo 2024-10-21).')
  }
  return { api_version: v }
}

/**
 * Whether the control plane may call this configuration to test it: only a
 * known provider at its own address, never an address an administrator typed
 * (it could point at the control plane's own network).
 */
export function testable(provider, storedBaseUrl) {
  const info = describe(provider)
  if (!info || info.custom || !info.models || !info.base) return false
  return !storedBaseUrl || storedBaseUrl === info.base
}

/**
 * Lists the provider's models with `apiKey`, from the control plane, at the
 * provider's own address (see testable).
 *
 * @returns {{ ok: boolean, status?: number, models?: number, ids?: string[], ms: number, message: string }}
 *   ids: the model IDs the account can use (at most MAX_IDS).
 */
export const MAX_IDS = 1000

export async function testConnection(provider, apiKey, { fetchImpl = fetch, timeoutMs = 8000 } = {}) {
  const info = testable(provider) ? describe(provider) : null
  if (!info) return { ok: false, ms: 0, message: 'Este proveedor se prueba desde un gateway.' }
  const headers = { accept: 'application/json' }
  if (info.protocol === 'anthropic') {
    headers['x-api-key'] = apiKey
    headers['anthropic-version'] = '2023-06-01'
  } else {
    headers.authorization = `Bearer ${apiKey}`
  }
  const started = Date.now()
  try {
    const res = await fetchImpl(info.base + info.models, { headers, signal: AbortSignal.timeout(timeoutMs), redirect: 'error' })
    const ms = Date.now() - started
    if (!res.ok) {
      const message = res.status === 401 || res.status === 403
        ? 'El proveedor rechazó la credencial.'
        : `El proveedor respondió ${res.status}.`
      return { ok: false, status: res.status, ms, message }
    }
    const body = await res.json().catch(() => null)
    const list = Array.isArray(body?.data) ? body.data : Array.isArray(body?.models) ? body.models : null
    // OpenAI-compatible lists and Anthropic's use "id", Gemini's native one
    // "name"; Gemini prefixes both with "models/".
    const ids = (list ?? [])
      .map(m => (typeof m?.id === 'string' ? m.id : typeof m?.name === 'string' ? m.name : null))
      .map(id => id?.replace(/^models\//, ''))
      .filter(id => id && id.length <= 200)
      .slice(0, MAX_IDS)
    return { ok: true, status: res.status, ms, models: list?.length, ids, message: 'Conexión correcta.' }
  } catch (err) {
    return { ok: false, ms: Date.now() - started, message: err?.name === 'TimeoutError' ? 'El proveedor no respondió a tiempo.' : 'No se pudo conectar con el proveedor.' }
  }
}
