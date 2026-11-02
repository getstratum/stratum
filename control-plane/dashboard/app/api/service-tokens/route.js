/**
 * Service tokens: the console's API for automation (lib/service-tokens.js).
 *
 * GET  /api/service-tokens → { tokens, scopes, expiryChoices }
 * POST /api/service-tokens { name, scopes: [...], expiresInDays } → a new
 *      one (Owner); its value is in the answer, this once
 *
 * A token never reaches these routes: tokens do not make tokens.
 */
export const dynamic = 'force-dynamic'
import { route, readJson, json } from '../../../lib/route.js'
import { audit } from '../../../lib/audit.js'
import { EXPIRY_CHOICES, SCOPES, TOKEN_COLUMNS, createToken, parseNewToken } from '../../../lib/service-tokens.js'

export const GET = route('tokens.read', async (req, { session, db }) => {
  const { rows } = await db.query(
    `SELECT ${TOKEN_COLUMNS} FROM service_tokens t LEFT JOIN users u ON u.id = t.created_by
      WHERE t.org_id = $1 ORDER BY t.revoked_at NULLS FIRST, t.created_at DESC`, [session.orgId])
  return json({ tokens: rows, scopes: SCOPES, expiryChoices: EXPIRY_CHOICES })
}, { serviceTokens: false })

export const POST = route('tokens.manage', async (req, { session, db }) => {
  const t = parseNewToken(await readJson(req))
  const { id, raw } = await createToken(db, session, t)
  await audit(db, { req, session, action: 'service_token.create', targetType: 'service_token', targetId: id,
    details: { name: t.name, scopes: t.scopes, days: t.days } })
  const { rows: [token] } = await db.query(
    `SELECT ${TOKEN_COLUMNS} FROM service_tokens t LEFT JOIN users u ON u.id = t.created_by WHERE t.id = $1`, [id])
  return json({ token, value: raw }, 201)
}, { serviceTokens: false })
