/**
 * One MCP server (lib/mcp.js, ADR-0016).
 *
 * PATCH  /api/mcp-servers/:id { description?, url?, authHeader?, secret?, enabled? } — the name stays:
 *        agents and policies use it
 * DELETE /api/mcp-servers/:id — refused while a policy allows it
 */
export const dynamic = 'force-dynamic'
import { route, readJson, json, badRequest, notFound, conflict } from '../../../../lib/route.js'
import { audit } from '../../../../lib/audit.js'
import { secretHint } from '../../../../lib/secrets.js'
import { serverFields } from '../../../../lib/mcp.js'
import { COLUMNS, encrypt } from '../route.js'

const idOf = (params) => {
  if (typeof params?.id !== 'string' || !/^mcp_[0-9a-f]{16}$/.test(params.id)) throw notFound('Servidor MCP no encontrado.')
  return params.id
}

export const PATCH = route('providers.manage', async (req, { session, db, params }) => {
  const id = idOf(await params)
  const body = await readJson(req)
  if (body.name !== undefined) throw badRequest('El nombre no cambia: lo usan los agentes y las políticas. Creá otro servidor.')
  const f = serverFields(body)
  const { rows: [now] } = await db.query('SELECT auth_header, secret_hint FROM mcp_servers WHERE id = $1 AND org_id = $2', [id, session.orgId])
  if (!now) throw notFound('Servidor MCP no encontrado.')
  const header = 'authHeader' in f ? f.authHeader : now.auth_header
  if ((f.secret || ('secret' in f ? false : now.secret_hint)) && !header) throw badRequest('Indicá en qué encabezado va la credencial.')

  const sets = ['updated_by = $3', 'updated_at = now()']
  const values = [id, session.orgId, session.email]
  const put = (col, v) => { values.push(v); sets.push(`${col} = $${values.length}`) }
  if ('description' in f) put('description', f.description)
  if ('url' in f) put('url', f.url)
  if ('authHeader' in f) put('auth_header', f.authHeader)
  if ('secret' in f) { put('secret_encrypted', f.secret ? encrypt(f.secret) : null); put('secret_hint', secretHint(f.secret)) }
  if ('enabled' in f) put('enabled', f.enabled)
  const { rows: [row] } = await db.query(
    `UPDATE mcp_servers SET ${sets.join(', ')} WHERE id = $1 AND org_id = $2 RETURNING ${COLUMNS}`, values)
  const { secret, ...details } = f
  await audit(db, { req, session, action: 'mcp_server.update', targetType: 'mcp_server', targetId: row.name,
    details: { ...details, ...('secret' in f ? { secret: secret ? 'changed' : 'removed' } : {}) } })
  return json({ server: row })
})

export const DELETE = route('providers.manage', async (req, { session, db, params }) => {
  const id = idOf(await params)
  const { rows: [s] } = await db.query('SELECT name FROM mcp_servers WHERE id = $1 AND org_id = $2', [id, session.orgId])
  if (!s) throw notFound('Servidor MCP no encontrado.')
  const { rows: using } = await db.query(`
    SELECT name FROM policies
     WHERE org_id = $1 AND EXISTS (SELECT 1 FROM unnest(mcp_tools) t WHERE t LIKE $2 || '/%')
     ORDER BY name`, [session.orgId, s.name])
  if (using.length) throw conflict(`Lo permiten las políticas ${using.map(p => p.name).join(', ')}. Quitalo de ellas primero.`)
  await db.query('DELETE FROM mcp_servers WHERE id = $1 AND org_id = $2', [id, session.orgId])
  await audit(db, { req, session, action: 'mcp_server.delete', targetType: 'mcp_server', targetId: s.name })
  return json({ ok: true })
})
