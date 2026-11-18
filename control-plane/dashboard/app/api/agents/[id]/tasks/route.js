export const dynamic = 'force-dynamic'
import { route, json, badRequest, notFound, idParam } from '../../../../../lib/route.js'
import { detail, WINDOWS } from '../../../../../lib/agent-tasks.js'

// GET /api/agents/:id/tasks?days=7|30|90 → { days, summary, reasons, recent,
// open }: the agent's results (the gateway's ADR-0019, lib/agent-tasks.js).
export const GET = route('users.read', async (req, { session, db, params }) => {
  const id = idParam(params)
  const { rows } = await db.query('SELECT team_id::text AS team_id FROM agents WHERE id = $1 AND org_id = $2', [id, session.orgId])
  const a = rows[0]
  if (!a || (session.scope === 'team' && a.team_id !== session.teamId)) throw notFound('Agente no encontrado.')
  const days = Number(new URL(req.url).searchParams.get('days') ?? 30)
  if (!WINDOWS.includes(days)) throw badRequest(`days es ${WINDOWS.join(', ')}.`)
  return json(await detail(db, session.orgId, id, days))
})
