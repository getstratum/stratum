/**
 * The model catalog as the session's organization sees it.
 *
 * GET   /api/models — catalog models (shared by every organization: IDs,
 *       aliases, list prices) with this organization's settings, plus models
 *       a provider listed for it in a connection test that the catalog does
 *       not have (source "provider", no price).
 * PATCH /api/models  { provider, model_id, enabled?, input_per_mtok?, output_per_mtok? }
 *       — turn a model off or on for the organization (gateways refuse it
 *       even under "all models"), or set the prices it pays (null: list
 *       price). Prices in US$ per million tokens.
 */

export const dynamic = 'force-dynamic'
import { route, json, readJson, badRequest } from '../../../lib/route.js'
import { audit } from '../../../lib/audit.js'

export const GET = route('models.read', async (req, { db, session }) => {
  const { rows } = await db.query(`
    SELECT m.provider, m.model_id, m.display_name, m.aliases,
           m.cost_per_1k_input_tokens, m.cost_per_1k_output_tokens,
           m.deprecated_on, m.updated_at, 'catalog' AS source,
           COALESCE(s.enabled, true) AS enabled,
           s.cost_per_1k_input_tokens AS org_cost_per_1k_input_tokens,
           s.cost_per_1k_output_tokens AS org_cost_per_1k_output_tokens
      FROM ai_models m
      LEFT JOIN org_model_settings s
        ON s.org_id = $1 AND s.provider = m.provider AND s.model_id = m.model_id
     WHERE m.is_active = true
    UNION ALL
    SELECT pm.provider, pm.model_id, pm.model_id, '{}'::text[],
           NULL, NULL, NULL, pm.seen_at, 'provider',
           COALESCE(s.enabled, true),
           s.cost_per_1k_input_tokens, s.cost_per_1k_output_tokens
      FROM provider_models pm
      LEFT JOIN org_model_settings s
        ON s.org_id = pm.org_id AND s.provider = pm.provider AND s.model_id = pm.model_id
     WHERE pm.org_id = $1
       AND NOT EXISTS (SELECT 1 FROM ai_models m
                        WHERE m.provider = pm.provider
                          AND (m.model_id = pm.model_id OR pm.model_id = ANY(m.aliases)))
     ORDER BY 1, 3
  `, [session.orgId])
  return json(rows)
})

const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:@/+-]{0,199}$/

function perMillion(v, name) {
  if (v === null) return null
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 100000) {
    throw badRequest(`${name}: un precio en US$ por millón de tokens, de 0 a 100000, o null para el de lista.`)
  }
  return Math.round(v * 1e6) / 1e9 // stored per 1K tokens
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
  for (const [field, col] of [['input_per_mtok', 'cost_per_1k_input_tokens'], ['output_per_mtok', 'cost_per_1k_output_tokens']]) {
    if (body[field] !== undefined) {
      values.push(perMillion(body[field], field)); sets.push([col, `$${values.length}`]); changed[field] = body[field]
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
    RETURNING provider, model_id, enabled, cost_per_1k_input_tokens, cost_per_1k_output_tokens`, values)
  await audit(db, {
    req, session, action: 'model.update', targetType: 'model', targetId: `${provider}/${modelId}`, details: changed,
  })
  return json(row)
})
