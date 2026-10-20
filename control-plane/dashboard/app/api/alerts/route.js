export const dynamic = 'force-dynamic'
import { route, readJson, json, badRequest, assertTeamInScope } from '../../../lib/route.js'
import { audit } from '../../../lib/audit.js'
import { alertFields, checkDestination } from '../../../lib/alerts.js'

export const GET = route('alerts.read', async (req, { session, db }) => {
  const team = session.scope === 'team'
  const { rows } = await db.query(`
    SELECT a.id, a.alert_type, a.threshold_pct, a.channel,
           a.destination, a.is_active, a.last_fired_at, a.created_at,
           a.last_error, a.last_error_at,
           t.id AS team_id, t.name AS team_name
      FROM alerts a
      LEFT JOIN teams t ON t.id = a.team_id AND t.org_id = a.org_id
     WHERE a.org_id = $1 ${team ? 'AND a.team_id = $2' : ''}
     ORDER BY t.name NULLS FIRST, a.alert_type
  `, team ? [session.orgId, session.teamId] : [session.orgId])
  return json(rows)
})

export const POST = route('alerts.manage', async (req, { session, db }) => {
  const body = await readJson(req)
  if (!body.teamId) throw badRequest('El equipo es obligatorio.')
  await assertTeamInScope(db, session, body.teamId)
  const f = alertFields(body, { create: true })
  checkDestination(f.channel, f.destination)
  const { rows } = await db.query(`
    INSERT INTO alerts (org_id, team_id, alert_type, threshold_pct, channel, destination)
    VALUES ($1, $2, $3, $4, $5, $6)
    RETURNING id, team_id, alert_type, threshold_pct, channel, destination, is_active, last_fired_at, created_at
  `, [session.orgId, body.teamId, f.alertType, f.thresholdPct ?? 80, f.channel, f.destination])
  await audit(db, {
    req, session, action: 'alert.create', targetType: 'alert', targetId: rows[0].id,
    details: { teamId: body.teamId, alertType: f.alertType, channel: f.channel },
  })
  return json(rows[0], 201)
})
