export const dynamic = 'force-dynamic'
import { route, readJson, json, badRequest, assertTeamInScope } from '../../../lib/route.js'
import { newApiKey, AGENT_COLUMNS, fixedModel, fixedModelProvider, delegatesFlag } from '../../../lib/users.js'
import { audit } from '../../../lib/audit.js'

export const GET = route('users.read', async (req, { session, db }) => {
  const team = session.scope === 'team'
  const { rows } = await db.query(`
    SELECT ${AGENT_COLUMNS},
      p.name AS policy_name,
      COUNT(r.id)                                        AS requests_month,
      COALESCE(SUM(r.tokens_input + r.tokens_output), 0) AS tokens_month,
      COALESCE(SUM(r.cost_usd), 0)                       AS cost_month
    FROM agents a
    LEFT JOIN teams t        ON t.id = a.team_id
    LEFT JOIN policies p     ON p.id = t.policy_id
    LEFT JOIN request_logs r ON r.agent_id = a.id
                             AND r.org_id = a.org_id
                             AND r.created_at >= date_trunc('month', now())
    WHERE a.org_id = $1 ${team ? 'AND a.team_id = $2' : ''}
    GROUP BY a.id, t.id, t.name, p.name
    ORDER BY a.created_at DESC
  `, team ? [session.orgId, session.teamId] : [session.orgId])
  return json(rows)
})

export const POST = route('keys.manage', async (req, { session, db }) => {
  const body = await readJson(req)
  const name = typeof body.name === 'string' ? body.name.trim() : ''
  if (!name) throw badRequest('El nombre es obligatorio.')
  // A key works only under a team's policy, so an agent always has a team.
  const teamId = body.teamId || (session.scope === 'team' ? session.teamId : null)
  if (!teamId) throw badRequest('El agente necesita un equipo.')
  await assertTeamInScope(db, session, teamId)

  const delegates = delegatesFlag(body.delegates, session) ?? false

  const key = newApiKey('aig_agt_')
  const { rows } = await db.query(`
    INSERT INTO agents (org_id, team_id, name, description, api_key_hash, api_key_prefix, default_model, default_provider, delegates)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    RETURNING id
  `, [session.orgId, teamId, name.slice(0, 255), body.description || null, key.hash, key.prefix,
      fixedModel(body.defaultModel), fixedModelProvider(body.defaultProvider), delegates])

  await audit(db, { req, session, action: 'agent.create', targetType: 'agent', targetId: rows[0].id, details: { name, teamId, delegates } })
  const { rows: agent } = await db.query(
    `SELECT ${AGENT_COLUMNS} FROM agents a LEFT JOIN teams t ON t.id = a.team_id WHERE a.id = $1`, [rows[0].id])
  return json({ agent: agent[0], apiKey: key.raw }, 201)
})
