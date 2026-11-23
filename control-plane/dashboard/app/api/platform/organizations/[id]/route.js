/**
 * One organization, for the platform API (ADR-0020). Platform token only.
 *
 * GET   /api/platform/organizations/:id  — as in the list, with what it has
 *       against each limit.
 * PATCH /api/platform/organizations/:id  { name?, plan?, limits?, features? }
 *       — limits are merged: a number sets one, null removes it. Lowering
 *       one never removes anything from the organization. features replaces
 *       the list (null: whatever the license includes).
 * POST  /api/platform/organizations/:id  { action, reason, confirm? }
 *       action: suspend | resume | delete | undelete. A reason (5 or more
 *       characters) always; delete also asks for the organization's name as
 *       written (confirm), and deletes it 30 days later (lib/org-deletion.js).
 */
export const dynamic = 'force-dynamic'
import { platformRoute, json, readJson, badRequest, notFound } from '@/lib/route'
import { getOrg, setPlan, setStatus } from '@/lib/org-admin'
import { markForDeletion, undoDeletion } from '@/lib/org-deletion'
import { withClient } from '@/lib/platform'

export const GET = platformRoute(async (req, { db, params }) => {
  const org = await getOrg(db, params.id)
  if (!org) throw notFound(`No organization with id ${params.id}.`)
  return json(org)
})

export const PATCH = platformRoute(async (req, { db, actor, params }) => {
  const body = await readJson(req)
  await withClient(db, c => setPlan(c, { orgId: params.id, name: body.name, plan: body.plan, limits: body.limits, features: body.features, actor }))
  return json(await getOrg(db, params.id))
})

export const POST = platformRoute(async (req, { db, actor, params }) => {
  const { action, reason, confirm } = await readJson(req)
  await withClient(db, c => {
    switch (action) {
      case 'suspend':  return setStatus(c, { orgId: params.id, status: 'suspended', reason, actor })
      case 'resume':   return setStatus(c, { orgId: params.id, status: 'active', reason, actor })
      case 'delete':   return markForDeletion(c, { orgId: params.id, confirmName: confirm, reason, actor })
      case 'undelete': return undoDeletion(c, { orgId: params.id, reason, actor })
      default: throw badRequest('action is suspend, resume, delete or undelete.')
    }
  })
  return json(await getOrg(db, params.id))
})
