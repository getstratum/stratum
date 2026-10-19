export const dynamic = 'force-dynamic'
import { route, readJson, json, badRequest, forbidden, notFound, conflict, idParam, isUuid, assertTeamInScope, withTransaction } from '../../../../lib/route.js'
import { scopeFor } from '../../../../lib/authz.js'
import { audit } from '../../../../lib/audit.js'

// A team manager may change their team's budget; the name and the policy
// need 'teams.manage'.
export const PATCH = route('teams.budget', async (req, { session, db, params }) => {
  const id = idParam(params)
  await assertTeamInScope(db, session, id)
  const body = await readJson(req)

  const fields = []
  const values = []
  const set = (col, val) => { values.push(val); fields.push(`${col} = $${values.length}`) }

  if (body.name !== undefined || body.policyId !== undefined) {
    if (scopeFor(session.role, 'teams.manage') !== 'org') throw forbidden('Tu rol solo puede cambiar el presupuesto del equipo.')
  }
  if (body.name !== undefined) {
    if (typeof body.name !== 'string' || !body.name.trim()) throw badRequest('Nombre inválido.')
    const name = body.name.trim().slice(0, 255)
    const { rows: dup } = await db.query(
      'SELECT 1 FROM teams WHERE org_id = $1 AND lower(name) = lower($2) AND id <> $3', [session.orgId, name, id])
    if (dup[0]) throw conflict(`Ya hay un equipo llamado ${name}.`)
    set('name', name)
  }
  if (body.policyId !== undefined) {
    const policyId = body.policyId || null
    if (policyId) {
      if (!isUuid(policyId)) throw badRequest('Política inválida.')
      const { rows } = await db.query('SELECT 1 FROM policies WHERE id = $1 AND org_id = $2', [policyId, session.orgId])
      if (!rows[0]) throw notFound('Política no encontrada.')
    }
    set('policy_id', policyId)
  }
  if (body.monthlyBudgetUsd !== undefined) {
    const v = body.monthlyBudgetUsd === null ? null : Number(body.monthlyBudgetUsd)
    if (v !== null && !(Number.isFinite(v) && v >= 0)) throw badRequest('Presupuesto inválido.')
    set('monthly_budget_usd', v)
  }
  if (!fields.length) throw badRequest('Nada para actualizar.')

  values.push(id, session.orgId)
  const { rows } = await db.query(
    `UPDATE teams SET ${fields.join(', ')} WHERE id = $${values.length - 1} AND org_id = $${values.length}
     RETURNING id, name, department, policy_id, monthly_budget_usd`, values)
  await audit(db, {
    req, session, action: 'team.update', targetType: 'team', targetId: id,
    details: {
      ...(body.name !== undefined ? { name: rows[0].name } : {}),
      ...(body.policyId !== undefined ? { policyId: rows[0].policy_id } : {}),
      ...(body.monthlyBudgetUsd !== undefined ? { monthlyBudgetUsd: rows[0].monthly_budget_usd } : {}),
    },
  })
  return json(rows[0])
})

// DELETE /api/teams/:id — only an empty team: people and agents are moved to
// another team first, so nobody loses access by surprise. The team's alerts
// go with it; its usage history stays (request_logs keep the team's ID).
// Gateways drop it on the next sync (tombstone, migration 015).
export const DELETE = route('teams.manage', async (req, { session, db, params }) => {
  const id = idParam(params)
  const team = await withTransaction(db, async (tx) => {
    const { rows } = await tx.query(
      `SELECT t.name,
              (SELECT count(*)::int FROM users u  WHERE u.team_id = t.id) AS members,
              (SELECT count(*)::int FROM agents a WHERE a.team_id = t.id) AS agents
         FROM teams t WHERE t.id = $1 AND t.org_id = $2 FOR UPDATE`, [id, session.orgId])
    const t = rows[0]
    if (!t) throw notFound('Equipo no encontrado.')
    if (t.members || t.agents) {
      const parts = [
        t.members ? `${t.members} ${t.members === 1 ? 'persona' : 'personas'}` : null,
        t.agents ? `${t.agents} ${t.agents === 1 ? 'agente' : 'agentes'}` : null,
      ].filter(Boolean).join(' y ')
      throw conflict(`${t.name} todavía tiene ${parts}. Movelos a otro equipo antes de eliminarlo.`)
    }
    await tx.query('DELETE FROM alerts WHERE team_id = $1 AND org_id = $2', [id, session.orgId])
    await tx.query('DELETE FROM teams WHERE id = $1 AND org_id = $2', [id, session.orgId])
    return t
  })
  await audit(db, { req, session, action: 'team.delete', targetType: 'team', targetId: id, details: { name: team.name } })
  return json({ ok: true })
})
