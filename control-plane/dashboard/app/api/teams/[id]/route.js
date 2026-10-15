export const dynamic = 'force-dynamic'
import { route, readJson, json, badRequest, forbidden, notFound, idParam, isUuid, assertTeamInScope } from '../../../../lib/route.js'
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
    set('name', body.name.trim().slice(0, 255))
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
