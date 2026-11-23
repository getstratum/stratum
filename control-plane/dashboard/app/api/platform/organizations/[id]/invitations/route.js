/**
 * The first Owner of an organization, by invitation (ADR-0020). Platform
 * token only.
 *
 * POST /api/platform/organizations/:id/invitations  { email }
 *      A link that works once, for 72 hours, where the Owner chooses their
 *      password and then their second factor. A new one for the same email
 *      replaces the open one ("resend"). Sent by email when the console has
 *      SMTP, and then the link is not in the answer: whoever runs the
 *      installation never holds it. Without SMTP (or if sending failed) the
 *      answer carries it, to pass on another way.
 * GET  /api/platform/organizations/:id/invitations
 *      The open invitations made from outside the organization (by the
 *      platform API or stratum-admin), to see whether the Owner came in.
 */
export const dynamic = 'force-dynamic'
import { platformRoute, json, readJson, notFound, HttpError } from '@/lib/route'
import { createInvitation, sendInvitation, baseUrl, linkFor } from '@/lib/invitations'
import { platformAudit } from '@/lib/org-deletion'
import { withClient } from '@/lib/platform'

// lib/invitations.js speaks to people in Spanish; this API, in English.
const ENGLISH = {
  bad_email: 'email is not a valid address.',
  not_found: 'No such organization.',
  org_unavailable: 'The organization is suspended or marked for deletion: resume it first.',
  email_taken: 'An account with that email already exists, in this or another organization.',
}

const isUuid = (v) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(v))

export const POST = platformRoute(async (req, { db, actor, params }) => {
  if (!isUuid(params.id)) throw notFound('No such organization.')
  const { email } = await readJson(req)
  let inv
  try {
    inv = await withClient(db, c => createInvitation(c, { orgId: params.id, email, role: 'owner', invitedBy: actor }))
  } catch (err) {
    if (err instanceof HttpError && ENGLISH[err.code]) throw new HttpError(err.status, err.code, ENGLISH[err.code])
    throw err
  }
  const link = linkFor(baseUrl(req), inv.raw)
  const delivery = await sendInvitation(inv, link)
  const details = { email: inv.email, role: 'owner', sent: delivery.sent, expires_at: inv.expiresAt }
  await db.query(
    `INSERT INTO audit_log (org_id, actor_label, action, target_type, target_id, result, details)
     VALUES ($1, $2, 'org.invite', 'invitation', $3, 'ok', $4)`, [params.id, actor, inv.id, JSON.stringify(details)])
  await platformAudit(db, { actor, action: 'org.invite', orgId: params.id, orgName: inv.orgName, details })
  return json({
    id: inv.id, email: inv.email, expires_at: inv.expiresAt, sent: delivery.sent,
    ...(delivery.sent ? {} : { link, reason: delivery.reason }),
  }, 201)
})

export const GET = platformRoute(async (req, { db, params }) => {
  if (!isUuid(params.id)) throw notFound('No such organization.')
  const { rows } = await db.query(
    `SELECT id, email, role, invited_by, created_at, expires_at, (expires_at <= now()) AS expired
       FROM invitations
      WHERE org_id = $1 AND accepted_at IS NULL AND revoked_at IS NULL
        AND (invited_by LIKE 'platform:%' OR invited_by = 'stratum-admin (CLI)')
      ORDER BY created_at DESC`, [params.id])
  return json({ invitations: rows })
})
