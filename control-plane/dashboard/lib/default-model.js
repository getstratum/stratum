/**
 * lib/default-model.js — a policy's default model (migration 039): what it
 * is, and whether its teams can use it.
 *
 * The default is "provider/model" or a route, "stratum/<name>". A route is
 * how a policy gets a second model: gateways skip the route's models the
 * policy does not allow and fall back while a provider fails (ADR-0015).
 *
 * A policy's default is, from the configuration alone:
 *
 *   ok        usable: a model, or a route whose first model is usable
 *   degraded  a route whose first model is not usable: requests go to a
 *             later one
 *   unusable  nothing of it is usable; a client starts with another model
 *
 * A model is usable for a policy when its provider is configured and on,
 * the policy allows the provider and the model, the organization did not
 * turn it off, the catalog did not retire it, and it is a chat model
 * (lib/model-kind.js): a default is what a chat starts with.
 *
 * Traffic adds a fourth state, falling_back (lib/default-model-notices.js):
 * the route's first model is usable but its provider fails, and requests are
 * going to the next one.
 */

import { badRequest } from './route.js'
import { effectiveKind } from './model-kind.js'

export const ROUTE_PREFIX = 'stratum'
const DEFAULT_RE = /^[a-z0-9][a-z0-9-]{0,49}\/[A-Za-z0-9][A-Za-z0-9._:@/+-]{0,199}$/

/** The default as sent by the console (null clears it), validated in form only. */
export function defaultModelField(v) {
  if (v === null || v === '') return null
  if (typeof v !== 'string' || !DEFAULT_RE.test(v.trim())) {
    throw badRequest('Modelo predeterminado: proveedor/modelo, o una ruta stratum/nombre.')
  }
  return v.trim()
}

/** "stratum/chat" → { route: 'chat' }; "groq/llama" → { provider, model }. */
export function parseDefault(v) {
  if (!v) return null
  const [provider, ...rest] = v.split('/')
  return provider === ROUTE_PREFIX ? { route: rest.join('/') } : { provider, model: rest.join('/') }
}

/**
 * What the organization has that decides whether a model is usable: its
 * configured providers, the catalog with its settings, the models providers
 * listed for it, and its routes. One query each, for any number of policies.
 */
export async function loadContext(db, orgId) {
  const q = async (text, params) => (await db.query(text, params)).rows
  const [providers, catalog, listed, aliases] = await Promise.all([
    q(`SELECT DISTINCT provider FROM provider_configs
        WHERE org_id = $1 AND COALESCE(enabled, false) AND NOT COALESCE(revoked, false)`, [orgId]),
    q(`SELECT m.provider, m.model_id, m.aliases, m.kind,
              (COALESCE(m.is_active, true) AND (m.deprecated_on IS NULL OR m.deprecated_on > now()::date)) AS active,
              COALESCE(s.enabled, true) AS enabled, s.kind AS own_kind
         FROM ai_models m
         LEFT JOIN org_model_settings s ON s.org_id = $1 AND s.provider = m.provider AND s.model_id = m.model_id`, [orgId]),
    q(`SELECT pm.provider, pm.model_id, pm.kind, COALESCE(s.enabled, true) AS enabled, s.kind AS own_kind
         FROM provider_models pm
         LEFT JOIN org_model_settings s ON s.org_id = pm.org_id AND s.provider = pm.provider AND s.model_id = pm.model_id
        WHERE pm.org_id = $1`, [orgId]),
    q('SELECT name, targets FROM model_aliases WHERE org_id = $1', [orgId]),
  ])
  return {
    providers: new Set(providers.map(p => p.provider)),
    catalog,
    listed,
    aliases: new Map(aliases.map(a => [a.name, Array.isArray(a.targets) ? a.targets : []])),
  }
}

function findModel(ctx, provider, model) {
  const c = ctx.catalog.find(m => m.provider === provider && (m.model_id === model || (m.aliases ?? []).includes(model)))
  if (c) return { ...c, names: [c.model_id, ...(c.aliases ?? [])], kind: effectiveKind({ own: c.own_kind, catalog: c.kind, id: c.model_id }) }
  const l = ctx.listed.find(m => m.provider === provider && m.model_id === model)
  if (l) return { ...l, active: true, names: [l.model_id], kind: effectiveKind({ own: l.own_kind, listed: l.kind, id: l.model_id }) }
  return { provider, model_id: model, active: true, enabled: true, names: [model], kind: effectiveKind({ id: model }) }
}

/** Why `policy` cannot use provider/model, or null when it can. */
export function whyNot(policy, ctx, provider, model) {
  const name = `${provider}/${model}`
  if (!ctx.providers.has(provider)) return `${provider} no está configurado o está deshabilitado`
  const allowedProviders = policy.allowed_providers ?? []
  if (allowedProviders.length && !allowedProviders.includes(provider)) return `la política no permite ${provider}`
  const m = findModel(ctx, provider, model)
  if (!policy.allow_all_models) {
    const listed = new Set(policy.allowed_models ?? [])
    if (!m.names.some(n => listed.has(n) || listed.has(`${provider}/${n}`))) return `la política no permite ${name}`
  }
  if (!m.enabled) return `${name} está apagado en la organización`
  if (!m.active) return `${name} se retiró del catálogo`
  if (m.kind !== 'chat') return `${name} no es un modelo de chat`
  return null
}

/**
 * The state of `policy`'s default from the configuration:
 * { state: 'none' | 'ok' | 'degraded' | 'unusable', detail, to, route, fallback }.
 * `to`: the model requests go to; `fallback`: whether there is a second
 * model after it (a route with another usable model).
 */
export function defaultState(policy, ctx) {
  const d = parseDefault(policy.default_model)
  if (!d) return { state: 'none', detail: '', to: null, route: null, fallback: false }
  if (!d.route) {
    const why = whyNot(policy, ctx, d.provider, d.model)
    return why
      ? { state: 'unusable', detail: `${why}.`, to: null, route: null, fallback: false }
      : { state: 'ok', detail: '', to: policy.default_model, route: null, fallback: false }
  }
  const targets = ctx.aliases.get(d.route)
  if (!targets) return { state: 'unusable', detail: `la ruta stratum/${d.route} no existe.`, to: null, route: d.route, fallback: false }
  const checked = targets.map(t => ({ name: `${t.provider}/${t.model}`, why: whyNot(policy, ctx, t.provider, t.model) }))
  const usable = checked.filter(t => !t.why)
  if (!usable.length) {
    return { state: 'unusable', detail: `ningún modelo de la ruta stratum/${d.route} se puede usar: ${checked.map(t => t.why).join('; ')}.`,
      to: null, route: d.route, fallback: false }
  }
  if (checked[0].why) {
    return { state: 'degraded', detail: `${checked[0].why}, así que los pedidos van a ${usable[0].name}.`,
      to: usable[0].name, route: d.route, fallback: usable.length > 1 }
  }
  return { state: 'ok', detail: '', to: usable[0].name, route: d.route, fallback: usable.length > 1 }
}
