/**
 * PATCH  /api/apps/:id  { name?, redirectUris?, requireMfa? }
 * POST   /api/apps/:id  { action: 'rotate-secret' } → the new secret, this once
 * DELETE /api/apps/:id  → revoked: no new sign-ins, codes or tokens
 */
export const dynamic = 'force-dynamic'
import { route, readJson, json, badRequest, notFound } from '../../../../lib/route.js'
import { audit } from '../../../../lib/audit.js'
import { newClientSecret, CLIENT_COLUMNS as COLUMNS, parseRedirectUris, parseAppName } from '../../../../lib/oidc.js'

async function load(db, session, params) {
  const id = params?.id
  if (typeof id !== 'string' || !/^app_[0-9a-f]{24}$/.test(id)) throw notFound('Aplicación no encontrada.')
  const { rows: [app] } = await db.query(
    `SELECT ${COLUMNS} FROM oidc_clients c WHERE c.id = $1 AND c.org_id = $2`, [id, session.orgId])
  if (!app) throw notFound('Aplicación no encontrada.')
  if (app.revoked_at) throw badRequest('La aplicación está dada de baja.')
  return app
}

export const PATCH = route('apps.manage', async (req, { session, db, params }) => {
  const app = await load(db, session, params)
  const body = await readJson(req)
  const sets = []
  const values = [app.id]
  const set = (col, v) => { values.push(v); sets.push(`${col} = $${values.length}`) }
  if (body.name !== undefined) set('name', parseAppName(body.name))
  if (body.redirectUris !== undefined) set('redirect_uris', parseRedirectUris(body.redirectUris))
  if (body.requireMfa !== undefined) {
    if (typeof body.requireMfa !== 'boolean') throw badRequest('requireMfa tiene que ser true o false.')
    set('require_mfa', body.requireMfa)
  }
  if (!sets.length) throw badRequest('Nada para actualizar.')
  const { rows: [updated] } = await db.query(
    `UPDATE oidc_clients SET ${sets.join(', ')} WHERE id = $1 RETURNING ${COLUMNS.replaceAll('c.', '')}`, values)
  await audit(db, { req, session, action: 'app.update', targetType: 'oidc_client', targetId: app.id,
    details: { name: updated.name, changed: Object.keys(body).filter(k => body[k] !== undefined) } })
  return json(updated)
})

export const POST = route('apps.manage', async (req, { session, db, params }) => {
  const app = await load(db, session, params)
  const { action } = await readJson(req)
  if (action !== 'rotate-secret') throw badRequest('Acción desconocida.')
  const secret = newClientSecret()
  await db.query('UPDATE oidc_clients SET secret_hash = $2 WHERE id = $1', [app.id, secret.hash])
  await audit(db, { req, session, action: 'app.secret.rotate', targetType: 'oidc_client', targetId: app.id, details: { name: app.name } })
  return json({ clientSecret: secret.raw })
})

export const DELETE = route('apps.manage', async (req, { session, db, params }) => {
  const app = await load(db, session, params)
  await db.query('UPDATE oidc_clients SET revoked_at = now() WHERE id = $1', [app.id])
  await db.query('DELETE FROM oidc_interactions WHERE client_id = $1', [app.id])
  await db.query('DELETE FROM oidc_codes WHERE client_id = $1', [app.id])
  await audit(db, { req, session, action: 'app.revoke', targetType: 'oidc_client', targetId: app.id, details: { name: app.name } })
  return json({ ok: true })
})
