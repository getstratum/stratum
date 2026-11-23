/**
 * The platform audit log (ADR-0020, migration 047): what was done to
 * organizations from outside them, which outlives them. Platform token only.
 *
 * GET /api/platform/audit[?org_id=<uuid>][&before=<id>][&limit=100]
 *
 * Newest first; `before` pages with the smallest id of the previous page.
 */
export const dynamic = 'force-dynamic'
import { platformRoute, json, badRequest } from '@/lib/route'

export const GET = platformRoute(async (req, { db }) => {
  const q = new URL(req.url).searchParams
  const orgId = q.get('org_id') || null
  if (orgId && !/^[0-9a-f-]{36}$/i.test(orgId)) throw badRequest('org_id is a UUID.')
  const before = q.get('before') ? Number(q.get('before')) : null
  if (before != null && !Number.isSafeInteger(before)) throw badRequest('before is an entry id.')
  const limit = Math.min(Math.max(Number(q.get('limit')) || 100, 1), 500)
  const { rows } = await db.query(
    `SELECT id::text AS id, at, actor, action, org_id, org_name, details FROM platform_audit
      WHERE ($1::uuid IS NULL OR org_id = $1) AND ($2::bigint IS NULL OR id < $2)
      ORDER BY id DESC LIMIT $3`, [orgId, before, limit])
  return json({ entries: rows })
})
