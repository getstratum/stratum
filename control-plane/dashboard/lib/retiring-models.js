/**
 * lib/retiring-models.js — telling an organization that a model it uses
 * retires (migration 053).
 *
 * The catalog says when a model retires (ai_models.deprecated_on, from the
 * feed). A model touches an organization when one of its policies names it
 * (by its ID or an alias, bare or as provider/model; a policy that allows
 * every model does not count), one of its routes has it as a target, or a
 * team used it in the last 30 days.
 *
 * Who is told, without setting anything up: the organization's Owners and
 * Admins, and the team managers of the teams it touches, by email
 * (STRATUM_SMTP_URL); also the active alerts of type "model_retiring" of
 * those teams, by their own channel (email or Slack). Twice: a month before
 * (31 days) and a week before (7 days); a model already retired that is
 * still named or used is told once, as "week". One message per
 * organization and round, listing every model newly due.
 *
 * Several control plane replicas claim each notice with an INSERT before
 * sending it. Modelos shows the same list whatever was sent.
 */

import { alertConfig, deliver } from './alert-delivery.js'

export const MONTH_DAYS = 31
export const WEEK_DAYS = 7
const USED_DAYS = 30

const fmt = (d) => new Date(`${d}T00:00:00Z`).toLocaleDateString('es-UY', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })

/**
 * The models retiring within MONTH_DAYS (or retired in the last 30 days)
 * that touch `orgId`, soonest first:
 * [{ provider, model_id, name, deprecated_on, days, policies, routes, used, teams: [{ id, name }] }]
 */
export async function retiringFor(db, orgId, { today = new Date() } = {}) {
  const day = today.toISOString().slice(0, 10)
  const { rows } = await db.query(`
    WITH m AS (
      SELECT provider, model_id, display_name, deprecated_on::text AS deprecated_on,
             (deprecated_on - $2::date) AS days,
             ARRAY[model_id::text] || aliases::text[] AS names
        FROM ai_models
       WHERE deprecated_on IS NOT NULL
         AND deprecated_on <= $2::date + $3::int AND deprecated_on >= $2::date - $4::int
    )
    SELECT m.provider, m.model_id, m.display_name AS name, m.deprecated_on, m.days,
           ARRAY(SELECT p.id::text FROM policies p
                  WHERE p.org_id = $1 AND NOT COALESCE(p.revoked, false)
                    AND (p.default_model = ANY(ARRAY(SELECT m.provider || '/' || n FROM unnest(m.names) n))
                         OR (NOT COALESCE(p.allow_all_models, false)
                             AND p.allowed_models && (m.names || ARRAY(SELECT m.provider || '/' || n FROM unnest(m.names) n))))
                  ORDER BY p.name) AS policy_ids,
           ARRAY(SELECT a.name FROM model_aliases a
                  WHERE a.org_id = $1
                    AND EXISTS (SELECT 1 FROM jsonb_array_elements(a.targets) t
                                 WHERE t->>'provider' = m.provider AND t->>'model' = ANY(m.names))
                  ORDER BY a.name) AS routes,
           ARRAY(SELECT DISTINCT r.team_id::text FROM request_logs r
                  WHERE r.org_id = $1 AND r.provider = m.provider AND r.model_id = ANY(m.names)
                    AND r.team_id IS NOT NULL AND r.created_at > now() - make_interval(days => $4::int)) AS used_teams,
           (SELECT count(*) FROM request_logs r
             WHERE r.org_id = $1 AND r.provider = m.provider AND r.model_id = ANY(m.names)
               AND r.created_at > now() - make_interval(days => $4::int))::int AS used
      FROM m
     ORDER BY m.deprecated_on, m.provider, m.model_id`, [orgId, day, MONTH_DAYS, USED_DAYS])
  const touching = rows.filter(r => r.policy_ids.length || r.routes.length || r.used > 0)
  if (!touching.length) return []
  const { rows: policies } = await db.query(
    'SELECT id::text, name FROM policies WHERE org_id = $1', [orgId])
  const { rows: teams } = await db.query(
    'SELECT id::text, name, policy_id::text FROM teams WHERE org_id = $1', [orgId])
  const policyName = new Map(policies.map(p => [p.id, p.name]))
  return touching.map(r => {
    const ids = new Set([...r.used_teams, ...teams.filter(t => r.policy_ids.includes(t.policy_id)).map(t => t.id)])
    return {
      provider: r.provider, model_id: r.model_id, name: r.name, deprecated_on: r.deprecated_on, days: Number(r.days),
      policies: r.policy_ids.map(id => policyName.get(id)).filter(Boolean),
      routes: r.routes, used: r.used,
      teams: teams.filter(t => ids.has(t.id)).map(t => ({ id: t.id, name: t.name })),
    }
  })
}

/** The step a model is due for: 'week' within 7 days (or retired), 'month' within 31, else null. */
export const stageOf = (days) => (days <= WEEK_DAYS ? 'week' : days <= MONTH_DAYS ? 'month' : null)

export function retiringMessage(orgName, models, { consoleUrl = null } = {}) {
  const subject = models.length === 1
    ? `[Stratum] ${models[0].model_id} ${models[0].days < 0 ? 'ya se retiró' : `se retira el ${fmt(models[0].deprecated_on)}`}`
    : `[Stratum] ${models.length} modelos que usa ${orgName} se retiran pronto`
  const lines = [`Modelos que ${orgName} usa y que su proveedor retira:`, '']
  for (const m of models) {
    const when = m.days < 0 ? `se retiró el ${fmt(m.deprecated_on)}`
      : m.days === 0 ? 'se retira hoy'
        : `se retira el ${fmt(m.deprecated_on)}, en ${m.days} ${m.days === 1 ? 'día' : 'días'}`
    lines.push(`- ${m.model_id} (${m.provider}): ${when}.`)
    if (m.policies.length) lines.push(`  Políticas que lo nombran: ${m.policies.join(', ')}.`)
    if (m.routes.length) lines.push(`  Rutas que lo usan: ${m.routes.map(r => `stratum/${r}`).join(', ')}.`)
    if (m.used) lines.push(`  Pedidos en los últimos ${USED_DAYS} días: ${m.used}.`)
  }
  lines.push('', 'Después de esa fecha el proveedor rechaza los pedidos a ese modelo. Pasá las políticas y las rutas a otro modelo antes.')
  if (consoleUrl) lines.push(`Modelos: ${consoleUrl}/models`)
  return { subject, text: lines.join('\n') }
}

/**
 * One round: for each active organization, the models newly due for a
 * notice, claimed and sent. Returns [{ orgId, models, sent, errors }].
 */
export async function evaluateRetiring(db, { cfg = alertConfig(), deps = {}, log = console, today = new Date() } = {}) {
  const { rows: orgs } = await db.query(
    `SELECT id::text, name FROM organizations WHERE status = 'active' AND delete_after IS NULL`)
  const results = []
  for (const org of orgs) {
    const due = (await retiringFor(db, org.id, { today })).filter(m => stageOf(m.days))
    if (!due.length) continue
    // Claim them: of several replicas, one sends each.
    const claimed = []
    for (const m of due) {
      const { rowCount } = await db.query(`
        INSERT INTO model_retirement_notices (org_id, provider, model_id, deprecated_on, stage)
        VALUES ($1, $2, $3, $4::date, $5) ON CONFLICT DO NOTHING`,
        [org.id, m.provider, m.model_id, m.deprecated_on, stageOf(m.days)])
      if (rowCount) claimed.push(m)
    }
    if (!claimed.length) continue
    results.push(await send(db, org, claimed, cfg, deps, log))
  }
  return results
}

async function send(db, org, models, cfg, deps, log) {
  const teamIds = [...new Set(models.flatMap(m => m.teams.map(t => t.id)))]
  const message = retiringMessage(org.name, models, { consoleUrl: cfg.consoleUrl })
  const { rows: people } = await db.query(`
    SELECT DISTINCT email FROM users
     WHERE org_id = $1 AND COALESCE(is_active, true) AND email IS NOT NULL
       AND (role IN ('owner', 'admin') OR (role = 'team_manager' AND team_id = ANY($2::uuid[])))
     ORDER BY email`, [org.id, teamIds])
  const { rows: alerts } = await db.query(`
    SELECT id, channel, destination FROM alerts
     WHERE org_id = $1 AND is_active AND alert_type = 'model_retiring' AND team_id = ANY($2::uuid[])`,
  [org.id, teamIds])
  const seen = new Set()
  const targets = [
    ...(cfg.smtpUrl ? people.map(u => ({ channel: 'email', destination: u.email })) : []),
    ...alerts,
  ].filter(t => { const k = `${t.channel}:${t.destination}`; if (seen.has(k)) return false; seen.add(k); return true })
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
  if (errors.length) log.error?.(`[retiring] ${org.name}: ${errors.length} of ${targets.length} not sent: ${errors[0]}`)
  return { orgId: org.id, models: models.map(m => `${m.provider}/${m.model_id}`), sent: targets.length - errors.length, errors }
}

