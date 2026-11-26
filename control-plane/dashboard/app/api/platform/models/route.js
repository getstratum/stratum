/**
 * The models the organizations' providers offer that the catalog does not
 * have, so whoever keeps the catalog (the Catalogador of stratum-ops) adds
 * what people can actually use. Platform token only.
 *
 * GET /api/platform/models
 *   → { models: [{ provider, model_id, kind, vision, tools, organizations, last_seen }] }
 *
 * Only counts, never which organization: a model ID is all that leaves.
 * Listed in the last 14 days (lib/provider-models.js lists them every day),
 * and neither an ID nor an alias of a catalog model of that provider.
 */
export const dynamic = 'force-dynamic'
import { platformRoute, json } from '@/lib/route'

export const GET = platformRoute(async (req, { db }) => {
  const { rows } = await db.query(`
    SELECT pm.provider, pm.model_id,
           mode() WITHIN GROUP (ORDER BY pm.kind) AS kind,
           bool_or(pm.vision) AS vision, bool_or(pm.tools) AS tools,
           count(DISTINCT pm.org_id)::int AS organizations,
           max(pm.seen_at) AS last_seen
      FROM provider_models pm
      JOIN organizations o ON o.id = pm.org_id AND o.status = 'active' AND o.delete_after IS NULL
     WHERE pm.seen_at > now() - interval '14 days'
       AND NOT EXISTS (SELECT 1 FROM ai_models m
                        WHERE m.provider = pm.provider
                          AND (m.model_id = pm.model_id OR pm.model_id = ANY(m.aliases)))
     GROUP BY pm.provider, pm.model_id
     ORDER BY count(DISTINCT pm.org_id) DESC, pm.provider, pm.model_id`)
  return json({ models: rows })
})
