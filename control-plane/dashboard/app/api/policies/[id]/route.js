export const dynamic = 'force-dynamic'
import { route, readJson, json, notFound, conflict, idParam } from '../../../../lib/route.js'
import { audit } from '../../../../lib/audit.js'
import { policyFields } from '../../../../lib/policies.js'

export const PATCH = route('policies.manage', async (req, { session, db, params }) => {
  const id = idParam(params)
  const f = policyFields(await readJson(req))
  const { rows } = await db.query(`
    UPDATE policies SET
      name                   = COALESCE($1, name),
      allowed_models         = COALESCE($2, allowed_models),
      max_tokens_per_request = COALESCE($3, max_tokens_per_request),
      monthly_token_quota    = COALESCE($4, monthly_token_quota),
      monthly_budget_usd     = COALESCE($5, monthly_budget_usd)
    WHERE id = $6 AND org_id = $7
    RETURNING *
  `, [f.name ?? null, f.allowedModels ?? null, f.maxTokensPerRequest ?? null,
      f.monthlyTokenQuota ?? null, f.monthlyBudgetUsd ?? null, id, session.orgId])
  if (!rows[0]) throw notFound('Política no encontrada.')
  await audit(db, { req, session, action: 'policy.update', targetType: 'policy', targetId: id, details: f })
  return json(rows[0])
})

export const DELETE = route('policies.manage', async (req, { session, db, params }) => {
  const id = idParam(params)
  const { rows: using } = await db.query(
    'SELECT count(*)::int AS n FROM teams WHERE policy_id = $1 AND org_id = $2', [id, session.orgId])
  if (using[0].n > 0) throw conflict('Esta política está asignada a uno o más equipos. Reasignalos primero.')
  const { rows } = await db.query(
    'DELETE FROM policies WHERE id = $1 AND org_id = $2 RETURNING name', [id, session.orgId])
  if (!rows[0]) throw notFound('Política no encontrada.')
  await audit(db, { req, session, action: 'policy.delete', targetType: 'policy', targetId: id, details: { name: rows[0].name } })
  return json({ ok: true })
})
