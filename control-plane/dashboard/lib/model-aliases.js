/**
 * lib/model-aliases.js — model aliases (ADR-0015, migration 037), "Rutas"
 * in the console: a name and up to four provider/model targets, in order.
 * A request for "stratum/<name>" goes to the first target the team's
 * policy allows and on to the next while a provider fails. Gateways get
 * the list with every sync (lib/sync.js).
 *
 * What the console holds: names gateways accept, targets of providers the
 * organization configured, every target in the same API format (Anthropic
 * Messages or OpenAI-compatible: gateways do not translate), no target
 * twice, and no alias deleted while an agent uses it as its fixed model.
 */

import { badRequest, conflict } from './route.js'

export const PREFIX = 'stratum'
export const MAX_TARGETS = 4
export const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,49}$/
const PROVIDER_RE = /^[a-z0-9][a-z0-9-]{0,49}$/
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/

/** The API format a provider takes: gateways send Anthropic's to Anthropic only. */
export const formatOf = (provider) => (provider === 'anthropic' ? 'anthropic' : 'openai')

export function parseName(value) {
  const name = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if (!NAME_RE.test(name)) {
    throw badRequest('El nombre va en minúsculas: letras, números, punto, guion y guion bajo, hasta 50 (por ejemplo "rapido").')
  }
  return name
}

/** { description, targets } from a request body, or a 400. */
export function parseAlias(body) {
  const description = typeof body?.description === 'string' ? body.description.trim().slice(0, 300) : ''
  const raw = Array.isArray(body?.targets) ? body.targets : []
  if (raw.length < 1 || raw.length > MAX_TARGETS) throw badRequest(`Una ruta va a entre 1 y ${MAX_TARGETS} modelos.`)
  const targets = raw.map((t) => {
    const provider = typeof t?.provider === 'string' ? t.provider.trim().toLowerCase() : ''
    const model = typeof t?.model === 'string' ? t.model.trim() : ''
    if (!PROVIDER_RE.test(provider) || provider === PREFIX) throw badRequest('Proveedor inválido.')
    if (!MODEL_RE.test(model)) throw badRequest('Modelo inválido.')
    return { provider, model }
  })
  const keys = targets.map(t => `${t.provider}/${t.model}`)
  if (new Set(keys).size !== keys.length) throw badRequest('Un modelo aparece dos veces.')
  if (new Set(targets.map(t => formatOf(t.provider))).size > 1) {
    throw badRequest('Anthropic usa otro formato de API que los demás proveedores, y los gateways no traducen entre formatos: una ruta va solo a modelos de Anthropic, o solo a modelos de los demás.')
  }
  return { description, targets }
}

/** Every provider of the targets has to be configured (and on) for the organization. */
export async function assertProviders(db, orgId, targets) {
  const { rows } = await db.query(
    `SELECT DISTINCT provider FROM provider_configs
      WHERE org_id = $1 AND provider = ANY($2) AND COALESCE(enabled, false) AND NOT COALESCE(revoked, false)`,
    [orgId, [...new Set(targets.map(t => t.provider))]])
  const have = new Set(rows.map(r => r.provider))
  const missing = [...new Set(targets.map(t => t.provider))].filter(p => !have.has(p))
  if (missing.length) throw badRequest(`Proveedores que la organización no tiene conectados: ${missing.join(', ')}.`)
}

/** An agent's fixed model naming an alias: it has to exist. */
export async function assertAliasExists(db, orgId, name) {
  if (typeof name !== 'string' || !NAME_RE.test(name)) throw badRequest('Esa ruta no existe.')
  const { rows } = await db.query('SELECT 1 FROM model_aliases WHERE org_id = $1 AND name = $2', [orgId, name])
  if (!rows.length) throw badRequest(`La ruta ${PREFIX}/${name} no existe.`)
}

/** Agents whose fixed model is this alias: it cannot be deleted under them. */
export async function assertUnused(db, orgId, name) {
  const { rows } = await db.query(
    `SELECT name FROM agents WHERE org_id = $1 AND default_provider = $2 AND default_model = $3 ORDER BY name`,
    [orgId, PREFIX, name])
  if (rows.length) {
    throw conflict(`La usan como modelo fijo: ${rows.map(r => r.name).join(', ')}. Cambiales el modelo primero.`)
  }
}

export const ALIAS_COLUMNS = 'name, description, targets, updated_by, updated_at'
