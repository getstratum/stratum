export const dynamic = 'force-dynamic'
import { route, json, badRequest } from '../../../lib/route.js'

// GET /api/audit?limit=100&before=<id>&result=denied
// The organization's audit log, newest first. `before` pages backwards.
export const GET = route('audit.read', async (req, { session, db }) => {
  const sp = new URL(req.url).searchParams
  const params = [session.orgId]
  const where = ['org_id = $1']
  const before = sp.get('before')
  if (before) {
    if (!/^\d{1,18}$/.test(before)) throw badRequest('before inválido.')
    params.push(before)
    where.push(`id < $${params.length}`)
  }
  const result = sp.get('result')
  if (result) {
    if (!['ok', 'denied', 'failed'].includes(result)) throw badRequest('result inválido.')
    params.push(result)
    where.push(`result = $${params.length}`)
  }
  const limit = Math.min(Math.max(parseInt(sp.get('limit') ?? '100', 10) || 100, 1), 500)
  params.push(limit)
  // ORDER BY names the column: a bare `id` would resolve to the `id::text`
  // output column and sort as text, so entry 9 came before entry 10.
  const { rows } = await db.query(
    `SELECT id::text, at, actor_user_id, actor_label, actor_role, action, target_type, target_id,
            result, ip, details
       FROM audit_log
      WHERE ${where.join(' AND ')}
      ORDER BY audit_log.id DESC
      LIMIT $${params.length}`,
    params)
  return json({ entries: rows, next: rows.length === limit ? rows[rows.length - 1].id : null })
})
