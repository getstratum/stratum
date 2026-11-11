/**
 * One model alias (lib/model-aliases.js, ADR-0015).
 *
 * PUT    /api/model-aliases/:name { description?, targets } → the alias as it is now
 * DELETE /api/model-aliases/:name → refused while an agent has it as its fixed model
 */
export const dynamic = 'force-dynamic'
import { route, json, readJson, notFound } from '../../../../lib/route.js'
import { audit } from '../../../../lib/audit.js'
import { ALIAS_COLUMNS, assertProviders, assertUnused, parseAlias, parseName } from '../../../../lib/model-aliases.js'

export const PUT = route('models.manage', async (req, { db, session, params }) => {
  const name = parseName(params.name)
  const { description, targets } = parseAlias(await readJson(req))
  await assertProviders(db, session.orgId, targets)
  const { rows: [row] } = await db.query(
    `UPDATE model_aliases SET description = $3, targets = $4, updated_by = $5, updated_at = now()
      WHERE org_id = $1 AND name = $2 RETURNING ${ALIAS_COLUMNS}`,
    [session.orgId, name, description, JSON.stringify(targets), session.email])
  if (!row) throw notFound('Esa ruta no existe.')
  await audit(db, { req, session, action: 'model_alias.update', targetType: 'model_alias', targetId: name, details: { targets } })
  return json({ alias: row })
})

export const DELETE = route('models.manage', async (req, { db, session, params }) => {
  const name = parseName(params.name)
  await assertUnused(db, session.orgId, name)
  const { rowCount } = await db.query('DELETE FROM model_aliases WHERE org_id = $1 AND name = $2', [session.orgId, name])
  if (!rowCount) throw notFound('Esa ruta no existe.')
  await audit(db, { req, session, action: 'model_alias.delete', targetType: 'model_alias', targetId: name })
  return json({ ok: true })
})
