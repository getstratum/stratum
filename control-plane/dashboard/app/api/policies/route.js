export const dynamic = 'force-dynamic'
import { route, readJson, json, badRequest } from '../../../lib/route.js'
import { audit } from '../../../lib/audit.js'
import { policyFields } from '../../../lib/policies.js'
import { loadContext, defaultState } from '../../../lib/default-model.js'

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
  // Whether each policy's default can be used (lib/default-model.js), and
  // whether its route is falling back (lib/default-model-notices.js).
  const ctx = await loadContext(db, session.orgId)
  const { rows: notices } = await db.query(
    `SELECT policy_id::text AS id, state, detail, since FROM default_model_notices WHERE org_id = $1`, [session.orgId])
  const traffic = new Map(notices.filter(n => n.state === 'falling_back').map(n => [n.id, n]))
  return json(rows.map(p => {
    const st = defaultState(p, ctx)
    const fb = traffic.get(String(p.id))
    return { ...p, default_state: fb && ['ok', 'degraded'].includes(st.state) ? { ...st, state: 'falling_back', detail: fb.detail, since: fb.since } : st }
  }))
})

export const POST = route('policies.manage', async (req, { session, db }) => {
  const body = await readJson(req)
  const f = policyFields(body)
  if (!f.name) throw badRequest('El nombre es obligatorio.')
  if (f.defaultModel) {
    const st = defaultState({ default_model: f.defaultModel, allowed_models: f.allowedModels ?? [],
      allow_all_models: f.allowAllModels ?? false, allowed_providers: f.allowedProviders ?? null }, await loadContext(db, session.orgId))
    if (st.state === 'unusable') throw badRequest(`No se puede usar ${f.defaultModel} como predeterminado: ${st.detail}`)
  }
  const { rows } = await db.query(`
    INSERT INTO policies
      (org_id, name, allowed_models, max_tokens_per_request, monthly_token_quota, monthly_budget_usd,
       allow_all_models, allowed_providers, budget_enforced, people_instructions, default_model, mcp_tools,
       pii_action, dlp_action)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
    RETURNING *
  `, [session.orgId, f.name, f.allowedModels ?? [], f.maxTokensPerRequest ?? null,
      f.monthlyTokenQuota ?? 1000000, f.monthlyBudgetUsd ?? 100,
      f.allowAllModels ?? false, f.allowedProviders ?? null, f.budgetEnforced ?? false,
      f.peopleInstructions ?? null, f.defaultModel ?? null, f.mcpTools ?? [],
      f.piiAction ?? 'off', f.dlpAction ?? 'off'])
  await audit(db, { req, session, action: 'policy.create', targetType: 'policy', targetId: rows[0].id, details: f })
  return json(rows[0], 201)
})
