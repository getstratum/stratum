export const dynamic = 'force-dynamic'
import { route, readJson, json, badRequest, notFound, conflict, isUuid } from '../../../lib/route.js'
import { audit } from '../../../lib/audit.js'

export const GET = route('teams.read', async (req, { session, db }) => {
  const team = session.scope === 'team'
  const { rows } = await db.query(
    `SELECT t.id, t.name, t.department, t.monthly_budget_usd,
            p.id AS policy_id, p.name AS policy_name, p.allowed_models,
            p.allow_all_models, p.allowed_providers
       FROM teams t
       LEFT JOIN policies p ON p.id = t.policy_id AND p.org_id = t.org_id
      WHERE t.org_id = $1 ${team ? 'AND t.id = $2' : ''}
      ORDER BY t.name`,
    team ? [session.orgId, session.teamId] : [session.orgId])
  return json(rows)
})

// POST /api/teams  { name, department?, policyId?, monthlyBudgetUsd? }
// Names are unique within the organization, ignoring case.
export const POST = route('teams.manage', async (req, { session, db }) => {
  const body = await readJson(req)
  const name = typeof body.name === 'string' ? body.name.trim().slice(0, 255) : ''
  if (!name) throw badRequest('El equipo necesita un nombre.')
  let department = null
  if (body.department != null && body.department !== '') {
    if (typeof body.department !== 'string') throw badRequest('Área inválida.')
    department = body.department.trim().slice(0, 255) || null
  }
  const policyId = body.policyId || null
  if (policyId) {
    if (!isUuid(policyId)) throw badRequest('Política inválida.')
    const { rows } = await db.query('SELECT 1 FROM policies WHERE id = $1 AND org_id = $2', [policyId, session.orgId])
    if (!rows[0]) throw notFound('Política no encontrada.')
  }
  let budget = null
  if (body.monthlyBudgetUsd != null && body.monthlyBudgetUsd !== '') {
    budget = Number(body.monthlyBudgetUsd)
    if (!(Number.isFinite(budget) && budget >= 0)) throw badRequest('Presupuesto inválido.')
  }

  const { rows: dup } = await db.query(
    'SELECT 1 FROM teams WHERE org_id = $1 AND lower(name) = lower($2)', [session.orgId, name])
  if (dup[0]) throw conflict(`Ya hay un equipo llamado ${name}.`)

  const { rows } = await db.query(
    `INSERT INTO teams (org_id, name, department, policy_id, monthly_budget_usd)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, name, department, policy_id, monthly_budget_usd`,
    [session.orgId, name, department, policyId, budget])
  await audit(db, {
    req, session, action: 'team.create', targetType: 'team', targetId: rows[0].id,
    details: { name, policyId },
  })
  return json(rows[0], 201)
})
