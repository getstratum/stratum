/**
 * The model catalog as the session's organization sees it.
 *
 * GET   /api/models — catalog models (shared by every organization: IDs,
 *       aliases, list prices) with this organization's settings, plus models
 *       a provider listed for it in a connection test that the catalog does
 *       not have (source "provider", no price). Each with its estimated
 *       emissions per 1,000 output tokens (impact_per_1k, lib/impacts), or
 *       null when the model has no estimate.
 *       Each with its kind (lib/model-kind.js): "kind", what it is for the
 *       organization; "org_kind", its own choice when it made one; and
 *       "auto_kind", what it would be without that choice. And what it can
 *       do (lib/model-capabilities.js): "capabilities" { vision, tools },
 *       "org_vision" / "org_tools" (its own choice, or null) and
 *       "auto_capabilities".
 * PATCH /api/models  { provider, model_id, enabled?, input_per_mtok?, output_per_mtok?, kind?, vision?, tools? }
 *       — turn a model off or on for the organization (gateways refuse it
 *       even under "all models"), set the prices it pays (null: list
 *       price), or say what kind of model it is (null: as the catalog, the
 *       provider or its ID say), or whether it reads images and calls tools
 *       (null: as they say). Prices in US$ per million tokens.
 */

export const dynamic = 'force-dynamic'
import { route, json, readJson, badRequest } from '../../../lib/route.js'
import { audit } from '../../../lib/audit.js'
import { estimate } from '../../../lib/impacts/index.js'
import { effectiveKind, isKind, KINDS } from '../../../lib/model-kind.js'
import { CAPABILITIES, effectiveCapabilities } from '../../../lib/model-capabilities.js'

// Per 1,000 output tokens, generation time from the model's own figures.
function perThousand(provider, model) {
  const e = estimate({ provider, model, tokensOut: 1000, durationMs: 0 })
  return e ? { gwp_g: e.gwp_g, energy_wh: e.energy_wh, water_ml: e.water_ml } : null
}

export const GET = route('models.read', async (req, { db, session }) => {
  const { rows } = await db.query(`
    SELECT m.provider, m.model_id, m.display_name, m.aliases,
           m.cost_per_1k_input_tokens, m.cost_per_1k_output_tokens,
           m.cost_per_image, m.cost_per_audio_minute,
           m.cost_per_1k_cache_write_tokens, m.cost_per_1k_cache_read_tokens,
           m.deprecated_on, m.updated_at, 'catalog' AS source,
           COALESCE(s.enabled, true) AS enabled,
           s.cost_per_1k_input_tokens AS org_cost_per_1k_input_tokens,
           s.cost_per_1k_output_tokens AS org_cost_per_1k_output_tokens,
           s.cost_per_image AS org_cost_per_image, s.cost_per_audio_minute AS org_cost_per_audio_minute,
           s.cost_per_1k_cache_write_tokens AS org_cost_per_1k_cache_write_tokens,
           s.cost_per_1k_cache_read_tokens AS org_cost_per_1k_cache_read_tokens,
           s.kind AS org_kind, m.kind AS catalog_kind, NULL AS listed_kind,
           s.vision AS org_vision, s.tools AS org_tools, m.vision AS catalog_vision, m.tools AS catalog_tools,
           NULL::boolean AS listed_vision, NULL::boolean AS listed_tools
      FROM ai_models m
      LEFT JOIN org_model_settings s
        ON s.org_id = $1 AND s.provider = m.provider AND s.model_id = m.model_id
     WHERE m.is_active = true
    UNION ALL
    SELECT pm.provider, pm.model_id, pm.model_id, '{}'::text[],
           NULL, NULL, NULL, NULL, NULL, NULL, NULL, pm.seen_at, 'provider',
           COALESCE(s.enabled, true),
           s.cost_per_1k_input_tokens, s.cost_per_1k_output_tokens, s.cost_per_image, s.cost_per_audio_minute,
           s.cost_per_1k_cache_write_tokens, s.cost_per_1k_cache_read_tokens,
           s.kind, NULL, pm.kind,
           s.vision, s.tools, NULL, NULL, pm.vision, pm.tools
      FROM provider_models pm
      LEFT JOIN org_model_settings s
        ON s.org_id = pm.org_id AND s.provider = pm.provider AND s.model_id = pm.model_id
     WHERE pm.org_id = $1
       AND NOT EXISTS (SELECT 1 FROM ai_models m
                        WHERE m.provider = pm.provider
                          AND (m.model_id = pm.model_id OR pm.model_id = ANY(m.aliases)))
     ORDER BY 1, 3
  `, [session.orgId])
  return json(rows.map(({ catalog_kind: catalog, listed_kind: listed, catalog_vision, catalog_tools, listed_vision, listed_tools, ...r }) => {
    const kind = effectiveKind({ own: r.org_kind, catalog, listed, id: r.model_id })
    const sources = { catalog: { vision: catalog_vision, tools: catalog_tools }, listed: { vision: listed_vision, tools: listed_tools }, id: r.model_id, kind }
    return {
      ...r,
      kind,
      auto_kind: effectiveKind({ catalog, listed, id: r.model_id }),
      // What it can do (lib/model-capabilities.js): with the organization's
      // choice, and without it ("Automático").
      capabilities: effectiveCapabilities({ ...sources, own: { vision: r.org_vision, tools: r.org_tools } }),
      auto_capabilities: effectiveCapabilities(sources),
      impact_per_1k: perThousand(r.provider, r.model_id),
    }
  }))
})

const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:@/+-]{0,199}$/

function perMillion(v, name) {
  if (v === null) return null
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 100000) {
    throw badRequest(`${name}: un precio en US$ por millón de tokens, de 0 a 100000, o null para el de lista.`)
  }
  return Math.round(v * 1e6) / 1e9 // stored per 1K tokens
}

// A price per image or per minute of audio, in US$ (ADR-0018).
function perUnit(v, name) {
  if (v === null) return null
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1000) {
    throw badRequest(`${name}: un precio en US$ de 0 a 1000, o null para el de lista.`)
  }
  return Math.round(v * 1e6) / 1e6
}

export const PATCH = route('models.manage', async (req, { db, session }) => {
  const body = await readJson(req)
  const { provider, model_id: modelId } = body
  if (typeof provider !== 'string' || !/^[a-z0-9][a-z0-9-]{0,49}$/.test(provider)) throw badRequest('provider inválido.')
  if (typeof modelId !== 'string' || !MODEL_RE.test(modelId)) throw badRequest('model_id inválido.')
  const { rows: [known] } = await db.query(`
    SELECT 1 FROM ai_models WHERE provider = $1 AND model_id = $2
    UNION ALL
    SELECT 1 FROM provider_models WHERE org_id = $3 AND provider = $1 AND model_id = $2
    LIMIT 1`, [provider, modelId, session.orgId])
  if (!known) throw badRequest('Ese modelo no está en el catálogo ni lo listó un proveedor de la organización.')

  const sets = []
  const values = [session.orgId, provider, modelId, session.email]
  const changed = {}
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== 'boolean') throw badRequest('enabled tiene que ser true o false.')
    values.push(body.enabled); sets.push(['enabled', `$${values.length}`]); changed.enabled = body.enabled
  }
  // The prompt cache (migration 052): null for the default, Anthropic's
  // multipliers on the input price or, for anyone else, the input price.
  for (const [field, col] of [['input_per_mtok', 'cost_per_1k_input_tokens'], ['output_per_mtok', 'cost_per_1k_output_tokens'],
    ['cache_write_per_mtok', 'cost_per_1k_cache_write_tokens'], ['cache_read_per_mtok', 'cost_per_1k_cache_read_tokens']]) {
    if (body[field] !== undefined) {
      values.push(perMillion(body[field], field)); sets.push([col, `$${values.length}`]); changed[field] = body[field]
    }
  }
  for (const [field, col] of [['per_image', 'cost_per_image'], ['per_audio_minute', 'cost_per_audio_minute']]) {
    if (body[field] !== undefined) {
      values.push(perUnit(body[field], field)); sets.push([col, `$${values.length}`]); changed[field] = body[field]
    }
  }
  if (body.kind !== undefined) {
    if (body.kind !== null && !isKind(body.kind)) throw badRequest(`kind: uno de ${KINDS.join(', ')}, o null para el que dicen el catálogo, el proveedor o su ID.`)
    values.push(body.kind); sets.push(['kind', `$${values.length}`]); changed.kind = body.kind
  }
  for (const c of CAPABILITIES) {
    if (body[c] !== undefined) {
      if (body[c] !== null && typeof body[c] !== 'boolean') throw badRequest(`${c}: true, false, o null para lo que dicen el catálogo, el proveedor o su ID.`)
      values.push(body[c]); sets.push([c, `$${values.length}`]); changed[c] = body[c]
    }
  }
  if (!sets.length) throw badRequest('Nada para actualizar.')

  const cols = sets.map(([c]) => c)
  const { rows: [row] } = await db.query(`
    INSERT INTO org_model_settings (org_id, provider, model_id, updated_by, updated_at, ${cols.join(', ')})
    VALUES ($1, $2, $3, $4, now(), ${sets.map(([, v]) => v).join(', ')})
    ON CONFLICT (org_id, provider, model_id) DO UPDATE
       SET updated_by = EXCLUDED.updated_by, updated_at = now(),
           ${cols.map(c => `${c} = EXCLUDED.${c}`).join(', ')}
    RETURNING provider, model_id, enabled, cost_per_1k_input_tokens, cost_per_1k_output_tokens,
              cost_per_image, cost_per_audio_minute, cost_per_1k_cache_write_tokens, cost_per_1k_cache_read_tokens,
              kind, vision, tools`, values)
  await audit(db, {
    req, session, action: 'model.update', targetType: 'model', targetId: `${provider}/${modelId}`, details: changed,
  })
  return json(row)
})
