/**
 * POST /api/alerts/:id/test — sends a test message now, with the team's
 * usage this month, so an administrator sees the webhook or the SMTP
 * settings work before the alert is needed. One per alert and minute.
 * Answers 200 { ok: true }, or 502 with the reason the send failed.
 */
export const dynamic = 'force-dynamic'
import { route, json, notFound, idParam, HttpError } from '../../../../../lib/route.js'
import { audit } from '../../../../../lib/audit.js'
import { alertConfig, buildMessage, deliver, measure, teamUsage } from '../../../../../lib/alert-delivery.js'

export const POST = route('alerts.manage', async (req, { session, db, params }) => {
  const id = idParam(params)
  const { rows: [alert] } = await db.query(`
    SELECT a.id, a.team_id::text AS team_id, a.alert_type, a.threshold_pct, a.channel, a.destination,
           t.name AS team_name, p.monthly_token_quota AS quota,
           COALESCE(t.monthly_budget_usd, p.monthly_budget_usd) AS budget
      FROM alerts a
      JOIN teams t ON t.id = a.team_id AND t.org_id = a.org_id
      LEFT JOIN policies p ON p.id = t.policy_id
     WHERE a.id = $1 AND a.org_id = $2`, [id, session.orgId])
  if (!alert || (session.scope === 'team' && alert.team_id !== session.teamId)) throw notFound('Alerta no encontrada.')

  const { rowCount } = await db.query(`
    UPDATE alerts SET last_test_at = now()
     WHERE id = $1 AND (last_test_at IS NULL OR last_test_at < now() - interval '1 minute')`, [id])
  if (!rowCount) throw new HttpError(429, 'too_many_requests', 'Ya se envió una prueba hace menos de un minuto.')

  const cfg = alertConfig()
  const usage = (await teamUsage(db, [alert.team_id])).get(alert.team_id)
  const { used, limit } = measure(alert, usage)
  const message = buildMessage(alert, { used, limit: limit ?? 0, pct: limit ? (used / limit) * 100 : 0 },
    { consoleUrl: cfg.consoleUrl, test: true })
  try {
    await deliver(alert, message, cfg)
  } catch (err) {
    const reason = String(err?.message ?? err).slice(0, 300)
    await audit(db, { req, session, action: 'alert.test', targetType: 'alert', targetId: id, details: { ok: false } })
    return json({ ok: false, message: `No se pudo enviar: ${reason}` }, 502)
  }
  await audit(db, { req, session, action: 'alert.test', targetType: 'alert', targetId: id, details: { ok: true } })
  return json({ ok: true })
})
