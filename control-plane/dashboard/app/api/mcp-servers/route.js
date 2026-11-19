/**
 * MCP servers of the session's organization (lib/mcp.js, ADR-0016).
 *
 * GET  /api/mcp-servers — list, with the policies that allow each one and
 *      the tools a gateway last saw on it (tools, tools_error, tools_at);
 *      never the credential, only its last characters
 * POST /api/mcp-servers { name, description?, url, authHeader?, secret?, enabled? }
 *
 * Gateways get them with the next sync and serve them at /mcp/<name>.
 */
export const dynamic = 'force-dynamic'
import { randomBytes } from 'node:crypto'
import { route, readJson, json, badRequest, conflict, HttpError } from '../../../lib/route.js'
import { audit } from '../../../lib/audit.js'
import { encryptSecret, secretHint } from '../../../lib/secrets.js'
import { serverFields } from '../../../lib/mcp.js'

export const COLUMNS = `id, name, description, url, auth_header, secret_hint, enabled, updated_by, updated_at`
// What each server offers, as the gateways last reported it (ADR-0016, from 0.9).
const CATALOG = `tools, tools_error, tools_at`

export function encrypt(value) {
  try {
    return encryptSecret(value)
  } catch {
    throw new HttpError(500, 'encryption_failed', 'No se pudo cifrar la credencial: revisá STRATUM_ENCRYPTION_KEY.')
  }
}

export const GET = route('providers.read', async (req, { session, db }) => {
  const { rows } = await db.query(`
    SELECT ${COLUMNS}, ${CATALOG},
           COALESCE((SELECT array_agg(p.name ORDER BY p.name) FROM policies p
                      WHERE p.org_id = s.org_id
                        AND EXISTS (SELECT 1 FROM unnest(p.mcp_tools) t WHERE t LIKE s.name || '/%')), '{}') AS policies
      FROM mcp_servers s
     WHERE s.org_id = $1
     ORDER BY s.name`, [session.orgId])
  return json({ servers: rows })
})

export const POST = route('providers.manage', async (req, { session, db }) => {
  const f = serverFields(await readJson(req), { create: true })
  if (f.secret && !f.authHeader) throw badRequest('Indicá en qué encabezado va la credencial (por ejemplo Authorization).')
  const id = `mcp_${randomBytes(8).toString('hex')}`
  try {
    const { rows: [row] } = await db.query(`
      INSERT INTO mcp_servers (id, org_id, name, description, url, auth_header, secret_encrypted, secret_hint, enabled, updated_by)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING ${COLUMNS}`,
      [id, session.orgId, f.name, f.description ?? '', f.url, f.authHeader ?? null,
       f.secret ? encrypt(f.secret) : null, secretHint(f.secret), f.enabled ?? true, session.email])
    await audit(db, { req, session, action: 'mcp_server.create', targetType: 'mcp_server', targetId: f.name,
      details: { url: f.url, authHeader: f.authHeader ?? null } })
    return json({ server: row }, 201)
  } catch (err) {
    if (err.code === '23505') throw conflict(`Ya hay un servidor MCP llamado ${f.name}.`)
    throw err
  }
})
