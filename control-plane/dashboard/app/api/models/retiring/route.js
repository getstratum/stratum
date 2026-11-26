/**
 * GET /api/models/retiring → the models the organization uses that retire
 * within a month (or retired in the last 30 days, still named or used):
 * what Modelos shows above the list, and what lib/retiring-models.js tells
 * Owners, Admins and team managers by email.
 */

export const dynamic = 'force-dynamic'
import { route, json } from '../../../../lib/route.js'
import { retiringFor } from '../../../../lib/retiring-models.js'

export const GET = route('models.read', async (req, { db, session }) => {
  const models = await retiringFor(db, session.orgId)
  return json({ models: models.map(({ teams, ...m }) => ({ ...m, teams: teams.map(t => t.name) })) })
})
