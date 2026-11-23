/**
 * The platform API's organizations (ADR-0020). Platform token only.
 *
 * GET  /api/platform/organizations  — every organization: state, plan,
 *      limits, the date it is deleted on if marked, and how many people,
 *      agents, teams and gateways it has. Nothing from inside it.
 * POST /api/platform/organizations  { name, plan?, limits? } — a new one,
 *      without people (its first Owner: an invitation, or create-owner).
 */
export const dynamic = 'force-dynamic'
import { platformRoute, json, readJson } from '@/lib/route'
import { listOrgs, createOrg, getOrg } from '@/lib/org-admin'
import { withClient } from '@/lib/platform'

export const GET = platformRoute(async (req, { db }) => json({ organizations: await listOrgs(db) }))

export const POST = platformRoute(async (req, { db, actor }) => {
  const body = await readJson(req)
  const { id } = await withClient(db, c => createOrg(c, { name: body.name, plan: body.plan, limits: body.limits, actor }))
  return json(await getOrg(db, id), 201)
})
