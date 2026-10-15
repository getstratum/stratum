export const dynamic = 'force-dynamic'
import { route, readJson, json, badRequest, notFound, idParam, assertTeamInScope } from '../../../../lib/route.js'
import { newApiKey, AGENT_COLUMNS } from '../../../../lib/users.js'
import { audit } from '../../../../lib/audit.js'

async function loadAgent(db, session, params) {
  const id = idParam(params)
  const { rows } = await db.query(
    'SELECT id, name, team_id::text AS team_id FROM agents WHERE id = $1 AND org_id = $2', [id, session.orgId])
  const a = rows[0]
  if (!a || (session.scope === 'team' && a.team_id !== session.teamId)) throw notFound('Agente no encontrado.')
  return a
}

export const PATCH = route('keys.manage', async (req, { session, db, params }) => {
  const agent = await loadAgent(db, session, params)
  const body = await readJson(req)

  const fields = []
  const values = []
  const set = (col, val) => { values.push(val); fields.push(`${col} = $${values.length}`) }

  if (body.name !== undefined) {
    if (typeof body.name !== 'string' || !body.name.trim()) throw badRequest('Nombre inválido.')
    set('name', body.name.trim().slice(0, 255))
  }
  if (body.description !== undefined) set('description', body.description || null)
  if (body.teamId !== undefined) {
    if (!body.teamId) throw badRequest('El agente necesita un equipo.')
    await assertTeamInScope(db, session, body.teamId)
    set('team_id', body.teamId || null)
  }
  if (body.isActive !== undefined) {
    if (typeof body.isActive !== 'boolean') throw badRequest('isActive tiene que ser true o false.')
    set('is_active', body.isActive)
  }
  if (body.defaultModel !== undefined) set('default_model', body.defaultModel || null)
  if (body.defaultProvider !== undefined) set('default_provider', body.defaultProvider || null)
  if (!fields.length) throw badRequest('Nada para actualizar.')

  values.push(agent.id, session.orgId)
  await db.query(
    `UPDATE agents SET ${fields.join(', ')} WHERE id = $${values.length - 1} AND org_id = $${values.length}`, values)
  await audit(db, {
    req, session, action: 'agent.update', targetType: 'agent', targetId: agent.id,
    details: { name: agent.name, changed: Object.keys(body).filter(k => body[k] !== undefined) },
  })
  const { rows } = await db.query(
    `SELECT ${AGENT_COLUMNS} FROM agents a LEFT JOIN teams t ON t.id = a.team_id WHERE a.id = $1`, [agent.id])
  return json(rows[0])
})

// POST /api/agents/:id  { action: 'rotate-key' | 'remove-key' }
export const POST = route('keys.manage', async (req, { session, db, params }) => {
  const agent = await loadAgent(db, session, params)
  const { action } = await readJson(req)
  if (action === 'remove-key') {
    await db.query(
      'UPDATE agents SET api_key_hash = NULL, api_key_prefix = NULL WHERE id = $1 AND org_id = $2',
      [agent.id, session.orgId])
    await audit(db, { req, session, action: 'agent.key.revoke', targetType: 'agent', targetId: agent.id, details: { name: agent.name } })
    return json({ ok: true })
  }
  if (action !== 'rotate-key') throw badRequest('Acción desconocida.')

  const key = newApiKey('aig_agt_')
  await db.query(
    'UPDATE agents SET api_key_hash = $1, api_key_prefix = $2 WHERE id = $3 AND org_id = $4',
    [key.hash, key.prefix, agent.id, session.orgId])
  await audit(db, { req, session, action: 'agent.key.rotate', targetType: 'agent', targetId: agent.id, details: { name: agent.name } })
  return json({ apiKey: key.raw })
})
