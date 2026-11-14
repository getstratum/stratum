/**
 * lib/default-model-notices.js — telling people when a policy's default
 * model stops working as set (H-09).
 *
 * Every alerts round (lib/alert-delivery.js) each policy with a default gets
 * a state: from its configuration (lib/default-model.js: ok, degraded,
 * unusable), and from traffic: falling_back when its default route's first
 * model is usable but its provider fails, and requests are going to the
 * next one (at least FALLBACK_MIN requests marked routed_fallback, and
 * FALLBACK_SHARE of the route's requests, in the last WINDOW_MIN minutes).
 *
 * Who is told, without setting anything up: the organization's Owners and
 * Admins, and the team managers of the teams with that policy, by email
 * (STRATUM_SMTP_URL). Also every active alert of type "default_model" of
 * those teams, by its own channel (email or Slack).
 *
 * When:
 *   - a problem: when it starts, then at most once every 24 hours while it
 *     changes, except a default that becomes unusable, told at once;
 *   - its end: once, when the default works again after a problem was told.
 * The state stays visible in Políticas whatever was sent. Several control
 * plane replicas claim each message with an UPDATE before sending it.
 */

import { alertConfig, deliver } from './alert-delivery.js'
import { loadContext, defaultState } from './default-model.js'

export const WINDOW_MIN = 15
export const FALLBACK_MIN = 2
export const FALLBACK_SHARE = 0.1
const DAY_MS = 24 * 60 * 60 * 1000
const RANK = { ok: 0, degraded: 1, falling_back: 2, unusable: 3 }

/** The state of every policy of `orgId` that has a default or had a notice. */
async function statesOf(db, orgId, policies, traffic) {
  const ctx = await loadContext(db, orgId)
  return policies.map(p => {
    const st = defaultState(p, ctx)
    const t = traffic.get(String(p.id))
    const falling = st.route && t && t.fell >= FALLBACK_MIN && t.fell >= FALLBACK_SHARE * t.total
    if (falling && ['ok', 'degraded'].includes(st.state)) {
      return { policy: p, state: 'falling_back', detail: `en los últimos ${WINDOW_MIN} minutos, ${t.fell} de ${t.total} pedidos a stratum/${st.route} fueron a otro modelo porque el proveedor del primero falló.` }
    }
    return { policy: p, state: st.state === 'none' ? 'ok' : st.state, detail: st.detail }
  })
}

export function noticeMessage(p, state, detail, teams, { consoleUrl = null, recovered = false } = {}) {
  const what = {
    degraded: 'no puede usar su primer modelo',
    unusable: 'no se puede usar',
    falling_back: 'está usando su segundo modelo',
  }[state]
  const subject = recovered
    ? `[Stratum] El modelo predeterminado de ${p.name} volvió a funcionar`
    : `[Stratum] El modelo predeterminado de ${p.name} ${what}`
  const lines = recovered
    ? [`${p.default_model}, el modelo predeterminado de la política ${p.name}, funciona otra vez como está configurado.`]
    : [`${p.default_model}, el modelo predeterminado de la política ${p.name}: ${detail}`,
       state === 'unusable'
         ? 'Las personas de sus equipos empiezan el chat con otro modelo, y los pedidos que no indican modelo se rechazan.'
         : 'Las personas siguen trabajando, con otro modelo que el elegido.']
  if (teams.length) lines.push(`Equipos con esta política: ${teams.join(', ')}.`)
  if (!recovered) lines.push('No se vuelve a avisar por esto en 24 horas, salvo que deje de poder usarse.')
  if (consoleUrl) lines.push(`Consola: ${consoleUrl}/policy`)
  return { subject, text: lines.join('\n') }
}

/**
 * One round. Returns what was sent: [{ policyId, state, sent, errors }].
 */
export async function evaluateDefaults(db, { cfg = alertConfig(), deps = {}, log = console } = {}) {
  const { rows: policies } = await db.query(`
    SELECT p.id, p.org_id, p.name, p.default_model, p.allowed_models, p.allow_all_models, p.allowed_providers,
           n.state AS last_state, n.notified_state, n.notified_at,
           -- To claim it exactly: a Date drops the microseconds.
           n.notified_at::text AS notified_at_text
      FROM policies p
      LEFT JOIN default_model_notices n ON n.policy_id = p.id
     WHERE (p.default_model IS NOT NULL AND NOT COALESCE(p.revoked, false)) OR n.policy_id IS NOT NULL`)
  if (!policies.length) return []

  // Requests to each policy's default route in the window, and how many of
  // them went to another model.
  const { rows: counts } = await db.query(`
    SELECT t.policy_id::text AS policy_id, count(*)::int AS total,
           (count(*) FILTER (WHERE 'routed_fallback' = ANY(r.labels)))::int AS fell
      FROM request_logs r
      JOIN teams t ON t.id = r.team_id
      JOIN policies p ON p.id = t.policy_id
     WHERE r.created_at > now() - make_interval(mins => $1)
       AND r.alias IS NOT NULL AND p.default_model = 'stratum/' || r.alias
     GROUP BY 1`, [WINDOW_MIN])
  const traffic = new Map(counts.map(c => [c.policy_id, c]))

  const results = []
  const byOrg = Map.groupBy(policies, p => p.org_id)
  for (const [orgId, list] of byOrg) {
    for (const { policy: p, state, detail } of await statesOf(db, orgId, list, traffic)) {
      // A default taken away: nothing left to tell about.
      if (!p.default_model) {
        await db.query('DELETE FROM default_model_notices WHERE policy_id = $1', [p.id])
        continue
      }
      // What the console shows in Políticas.
      await db.query(`
        INSERT INTO default_model_notices (policy_id, org_id, state, detail)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (policy_id) DO UPDATE
           SET detail = EXCLUDED.detail,
               since = CASE WHEN default_model_notices.state = EXCLUDED.state THEN default_model_notices.since ELSE now() END,
               state = EXCLUDED.state`, [p.id, orgId, state, detail])

      const told = p.notified_state ?? 'ok'
      const recovered = state === 'ok' && told !== 'ok'
      const problem = state !== 'ok' && state !== told && (
        !p.notified_at || Date.now() - new Date(p.notified_at).getTime() >= DAY_MS ||
        (state === 'unusable' && RANK[state] > RANK[told]))
      if (!recovered && !problem) continue

      // Claim it: of several replicas, one sends.
      const { rowCount } = await db.query(`
        UPDATE default_model_notices
           SET notified_state = $2, notified_at = CASE WHEN $2 = 'ok' THEN notified_at ELSE now() END
         WHERE policy_id = $1 AND notified_state IS NOT DISTINCT FROM $3 AND notified_at::text IS NOT DISTINCT FROM $4`,
        [p.id, state, p.notified_state, p.notified_at_text])
      if (!rowCount) continue
      results.push(await send(db, p, state, detail, recovered, cfg, deps, log))
    }
  }
  return results
}

async function send(db, p, state, detail, recovered, cfg, deps, log) {
  const { rows: teams } = await db.query(
    'SELECT id, name FROM teams WHERE policy_id = $1 AND org_id = $2 ORDER BY name', [p.id, p.org_id])
  const message = noticeMessage(p, state, detail, teams.map(t => t.name), { consoleUrl: cfg.consoleUrl, recovered })
  const { rows: people } = await db.query(`
    SELECT DISTINCT email FROM users
     WHERE org_id = $1 AND COALESCE(is_active, true) AND email IS NOT NULL
       AND (role IN ('owner', 'admin') OR (role = 'team_manager' AND team_id = ANY($2::uuid[])))
     ORDER BY email`, [p.org_id, teams.map(t => t.id)])
  const { rows: alerts } = await db.query(`
    SELECT id, channel, destination FROM alerts
     WHERE org_id = $1 AND is_active AND alert_type = 'default_model' AND team_id = ANY($2::uuid[])`,
    [p.org_id, teams.map(t => t.id)])

  const targets = [
    ...(cfg.smtpUrl ? people.map(u => ({ channel: 'email', destination: u.email })) : []),
    ...alerts,
  ]
  const errors = []
  for (const t of targets) {
    try {
      await deliver(t, message, cfg, deps)
      if (t.id) await db.query('UPDATE alerts SET last_fired_at = now(), last_error = NULL, last_error_at = NULL WHERE id = $1', [t.id])
    } catch (err) {
      const reason = String(err?.message ?? err).slice(0, 300)
      errors.push(reason)
      if (t.id) await db.query('UPDATE alerts SET last_error = $2, last_error_at = now() WHERE id = $1', [t.id, reason])
    }
  }
  if (errors.length) log.error?.(`[default-model] ${p.name}: ${errors.length} of ${targets.length} not sent: ${errors[0]}`)
  return { policyId: p.id, state, recovered, sent: targets.length - errors.length, errors }
}
