/**
 * The model catalog feed (lib/model-feed.js, ADR-0012).
 *
 * GET  /api/models/catalog — when it was last checked and applied, from where, and the last error
 * POST /api/models/catalog — check the feed now (the control plane does it once a day)
 */

export const dynamic = 'force-dynamic'
import { route, json } from '../../../../lib/route.js'
import { audit } from '../../../../lib/audit.js'
import { refreshCatalog, feedUrl } from '../../../../lib/model-feed.js'

async function state(db) {
  const { rows: [s] } = await db.query(
    `SELECT source, feed_updated, models, changed, checked_at, applied_at, error FROM model_catalog_state`)
  return { ...(s ?? {}), feed_url: feedUrl() }
}

export const GET = route('models.read', async (req, { db }) => json(await state(db)))

export const POST = route('models.manage', async (req, { db, session }) => {
  const result = await refreshCatalog(db)
  await audit(db, {
    req, session, action: 'models.catalog_refresh', targetType: 'model_catalog', targetId: null,
    result: result.ok ? 'ok' : 'failed', details: { changed: result.changed ?? null, message: result.message ?? null },
  })
  return json({ result, state: await state(db) })
})
