/**
 * Model aliases (lib/model-aliases.js, ADR-0015): "Rutas" in Modelos.
 *
 * GET  /api/model-aliases → { aliases: [{ name, description, targets, updated_by, updated_at }] }
 * POST /api/model-aliases { name, description?, targets: [{ provider, model }] } → the new one
 */
export const dynamic = 'force-dynamic'
import { route, json, readJson, conflict } from '../../../lib/route.js'
import { audit } from '../../../lib/audit.js'
import { ALIAS_COLUMNS, assertProviders, parseAlias, parseName } from '../../../lib/model-aliases.js'

export const GET = route('models.read', async (req, { db, session }) => {
  const { rows } = await db.query(
    `SELECT ${ALIAS_COLUMNS} FROM model_aliases WHERE org_id = $1 ORDER BY name`, [session.orgId])
  return json({ aliases: rows })
})

export const POST = route('models.manage', async (req, { db, session }) => {
  const body = await readJson(req)
  const name = parseName(body?.name)
  const { description, targets } = parseAlias(body)
  await assertProviders(db, session.orgId, targets)
  const { rows: [row] } = await db.query(
    `INSERT INTO model_aliases (org_id, name, description, targets, updated_by)
     VALUES ($1, $2, $3, $4, $5) ON CONFLICT (org_id, name) DO NOTHING
     RETURNING ${ALIAS_COLUMNS}`,
    [session.orgId, name, description, JSON.stringify(targets), session.email])
  if (!row) throw conflict(`Ya hay una ruta stratum/${name}.`)
  await audit(db, { req, session, action: 'model_alias.create', targetType: 'model_alias', targetId: name, details: { targets } })
  return json({ alias: row }, 201)
})
