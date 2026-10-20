export const dynamic = 'force-dynamic'
import { route, readJson, json, badRequest, notFound, idParam } from '../../../../lib/route.js'
import { audit } from '../../../../lib/audit.js'
import { alertFields, checkDestination } from '../../../../lib/alerts.js'

async function loadAlert(db, session, params) {
  const id = idParam(params)
  const { rows } = await db.query(
    'SELECT id, team_id::text AS team_id, channel, destination FROM alerts WHERE id = $1 AND org_id = $2', [id, session.orgId])
  const a = rows[0]
  if (!a || (session.scope === 'team' && a.team_id !== session.teamId)) throw notFound('Alerta no encontrada.')
  return a
}

export const PATCH = route('alerts.manage', async (req, { session, db, params }) => {
  const alert = await loadAlert(db, session, params)
  const body = await readJson(req)
  const f = alertFields(body)
  if (f.channel !== undefined || f.destination !== undefined) {
    checkDestination(f.channel ?? alert.channel, f.destination ?? alert.destination)
  }

  const fields = []
  const values = []
  const set = (col, val) => { values.push(val); fields.push(`${col} = $${values.length}`) }
  if (f.alertType !== undefined) set('alert_type', f.alertType)
  if (f.channel !== undefined) set('channel', f.channel)
  if (f.thresholdPct !== undefined) set('threshold_pct', f.thresholdPct)
  if (f.destination !== undefined) set('destination', f.destination)
  if (body.isActive !== undefined) {
    if (typeof body.isActive !== 'boolean') throw badRequest('isActive tiene que ser true o false.')
    set('is_active', body.isActive)
  }
  if (body.resetFired) { set('last_fired_at', null); set('last_error', null) }
  if (!fields.length) throw badRequest('Nada para actualizar.')

  values.push(alert.id, session.orgId)
  const { rows } = await db.query(
    `UPDATE alerts SET ${fields.join(', ')} WHERE id = $${values.length - 1} AND org_id = $${values.length}
     RETURNING id, team_id, alert_type, threshold_pct, channel, destination, is_active, last_fired_at, created_at,
               last_error, last_error_at`,
    values)
  const changed = Object.keys(f)
    .concat(body.isActive !== undefined ? ['isActive'] : [])
    .concat(body.resetFired ? ['resetFired'] : [])
  await audit(db, { req, session, action: 'alert.update', targetType: 'alert', targetId: alert.id, details: { changed } })
  return json(rows[0])
})

export const DELETE = route('alerts.manage', async (req, { session, db, params }) => {
  const alert = await loadAlert(db, session, params)
  await db.query('DELETE FROM alerts WHERE id = $1 AND org_id = $2', [alert.id, session.orgId])
  await audit(db, { req, session, action: 'alert.delete', targetType: 'alert', targetId: alert.id })
  return json({ ok: true })
})
