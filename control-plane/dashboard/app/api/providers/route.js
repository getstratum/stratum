export const dynamic = 'force-dynamic'
import { route, json } from '../../../lib/route.js'
import { LEGACY_PROVIDERS_GONE } from '../../../lib/providers-legacy.js'

// The legacy `providers` table is global (not per organization) and gateways
// do not read it. It stays readable; changes go through
// /api/internal/providers (provider_configs), per organization.
export const GET = route('providers.read', async (req, { db }) => {
  const { rows } = await db.query(`
    SELECT p.id, p.slug, p.display_name, p.base_url, p.api_type,
           p.api_key_env, p.is_active, p.notes,
           (p.api_key IS NOT NULL) AS has_api_key,
           COALESCE(
             json_agg(
               json_build_object(
                 'model_id',     m.model_id,
                 'display_name', m.display_name,
                 'input_cost',   m.cost_per_1k_input_tokens::text,
                 'output_cost',  m.cost_per_1k_output_tokens::text
               ) ORDER BY m.display_name
             ) FILTER (WHERE m.model_id IS NOT NULL), '[]'
           ) AS models
      FROM providers p
      LEFT JOIN ai_models m ON m.provider = p.slug
     GROUP BY p.id
     ORDER BY p.display_name
  `)
  return json(rows)
})

export const POST = route('providers.manage', async () => LEGACY_PROVIDERS_GONE())
