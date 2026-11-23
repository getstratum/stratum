/**
 * GET /api/org — "Mi organización" (ADR-0020): its state, its plan, each
 * limit with what the organization has now (tokens and spend: this UTC
 * month), and the date it is deleted on if it was marked. Owner, Admin and
 * Auditor. The limits are set from outside the organization: nothing here
 * changes them.
 */
export const dynamic = 'force-dynamic'
import { route, json } from '@/lib/route'
import { planState } from '@/lib/org-limits'

export const GET = route('org.plan.read', async (req, { session, db }) => {
  const { rows: [o] } = await db.query(
    'SELECT name, status, delete_after, created_at FROM organizations WHERE id = $1', [session.orgId])
  return json({ ...o, ...(await planState(db, session.orgId)) })
})
