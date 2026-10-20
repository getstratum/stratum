export const dynamic = 'force-dynamic'
import { route, readJson, json, badRequest } from '../../../lib/route.js'
import { audit } from '../../../lib/audit.js'
import { policyFields } from '../../../lib/policies.js'

export const GET = route('policies.read', async (req, { session, db }) => {
  const team = session.scope === 'team'
  const { rows } = await db.query(`
    SELECT p.*,
           (SELECT count(*) FROM teams t WHERE t.policy_id = p.id AND t.org_id = p.org_id) AS teams_using
      FROM policies p
     WHERE p.org_id = $1
       ${team ? 'AND p.id = (SELECT policy_id FROM teams WHERE id = $2 AND org_id = $1)' : ''}
     ORDER BY p.created_at
  `, team ? [session.orgId, session.teamId] : [session.orgId])
  return json(rows)
})

export const POST = route('policies.manage', async (req, { session, db }) => {
  const body = await readJson(req)
  const f = policyFields(body)
  if (!f.name) throw badRequest('El nombre es obligatorio.')
  const { rows } = await db.query(`
    INSERT INTO policies
      (org_id, name, allowed_models, max_tokens_per_request, monthly_token_quota, monthly_budget_usd,
       allow_all_models, allowed_providers, budget_enforced)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    RETURNING *
  `, [session.orgId, f.name, f.allowedModels ?? [], f.maxTokensPerRequest ?? null,
      f.monthlyTokenQuota ?? 1000000, f.monthlyBudgetUsd ?? 100,
      f.allowAllModels ?? false, f.allowedProviders ?? null, f.budgetEnforced ?? false])
  await audit(db, { req, session, action: 'policy.create', targetType: 'policy', targetId: rows[0].id, details: f })
  return json(rows[0], 201)
})
