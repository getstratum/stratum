/**
 * Alerts that are sent: every few minutes the control plane compares each
 * active alert's team usage this month with its quota or budget, and when it
 * reaches the threshold sends one message, by email (SMTP) or to a webhook
 * (Slack's incoming webhooks, or other chat tools allowed by the operator).
 *
 * - Once per alert and month: last_fired_at in the current UTC month means
 *   it was sent. "Reiniciar" in the console clears it.
 * - Several control plane replicas: an alert is claimed with an UPDATE before
 *   it is sent, so only one replica sends it. A failed send gives the claim
 *   back and records the error, and the next round tries again.
 * - The control plane only posts to webhook hosts the operator allows
 *   (STRATUM_ALERT_WEBHOOK_HOSTS, default hooks.slack.com): a URL typed into
 *   the console must not reach the control plane's own network.
 *
 * Configuration (environment):
 *   STRATUM_SMTP_URL             smtp://user:pass@host:587 (STARTTLS) or smtps://...:465; unset: no email
 *   STRATUM_ALERT_FROM           sender address; default alertas@<SMTP host>
 *   STRATUM_ALERT_WEBHOOK_HOSTS  comma-separated hosts; default hooks.slack.com
 *   STRATUM_CONSOLE_URL          link in the messages (optional)
 *   STRATUM_ALERTS_INTERVAL_S    seconds between rounds; default 300, 0 turns them off
 */

const MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto',
  'septiembre', 'octubre', 'noviembre', 'diciembre']

const nf = new Intl.NumberFormat('es-UY', { maximumFractionDigits: 0 })
const usd = new Intl.NumberFormat('es-UY', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

export function alertConfig(env = process.env) {
  const hosts = (env.STRATUM_ALERT_WEBHOOK_HOSTS ?? 'hooks.slack.com')
    .split(',').map(h => h.trim().toLowerCase()).filter(Boolean)
  const smtpUrl = (env.STRATUM_SMTP_URL ?? '').trim() || null
  let from = (env.STRATUM_ALERT_FROM ?? '').trim()
  if (!from && smtpUrl) {
    try { from = `alertas@${new URL(smtpUrl).hostname}` } catch { /* checked when sending */ }
  }
  const interval = Number(env.STRATUM_ALERTS_INTERVAL_S ?? 300)
  return {
    webhookHosts: hosts,
    smtpUrl,
    from,
    consoleUrl: (env.STRATUM_CONSOLE_URL ?? '').trim().replace(/\/+$/, '') || null,
    intervalS: Number.isFinite(interval) && interval >= 0 ? interval : 300,
  }
}

/** Why the control plane would refuse to post to this webhook URL, or null. */
export function webhookProblem(destination, cfg = alertConfig()) {
  let u
  try { u = new URL(destination) } catch { return 'no es una URL' }
  if (u.protocol !== 'https:') return 'tiene que ser https'
  if (u.username || u.password) return 'no puede llevar usuario ni contraseña'
  const host = u.hostname.toLowerCase()
  if (!cfg.webhookHosts.includes(host)) {
    return `el control plane solo envía a ${cfg.webhookHosts.join(', ')} (STRATUM_ALERT_WEBHOOK_HOSTS)`
  }
  return null
}

/** Where an alert stands this month: what it measures, against what. */
export function measure(alert, usage) {
  if (alert.alert_type === 'quota') {
    const limit = alert.quota == null ? null : Number(alert.quota)
    return { used: Number(usage?.tokens ?? 0), limit, unit: 'tokens' }
  }
  if (alert.alert_type === 'budget') {
    const limit = alert.budget == null ? null : Number(alert.budget)
    return { used: Number(usage?.cost ?? 0), limit, unit: 'usd' }
  }
  return { used: 0, limit: null, unit: null }
}

export function reached(alert, usage) {
  const { used, limit } = measure(alert, usage)
  if (!limit || limit <= 0) return null
  const pct = (used / limit) * 100
  return pct >= alert.threshold_pct ? { used, limit, pct } : null
}

/** The message, as text (email and webhooks), in the console's language. */
export function buildMessage(alert, { used, limit, pct }, { now = new Date(), consoleUrl = null, test = false } = {}) {
  const month = MONTHS[now.getUTCMonth()]
  const what = alert.alert_type === 'quota' ? 'su cuota de tokens' : 'su presupuesto'
  const amount = alert.alert_type === 'quota'
    ? `${nf.format(used)} de ${nf.format(limit)} tokens`
    : `US$ ${usd.format(used)} de US$ ${usd.format(limit)}`
  const subject = test
    ? `[Stratum] Prueba de la alerta de ${alert.team_name}`
    : `[Stratum] ${alert.team_name} llegó al ${nf.format(Math.floor(pct))} % de ${what} de ${month}`
  const lines = test
    ? [`Esta es una prueba de la alerta de ${alert.team_name} (${alert.threshold_pct} % de ${what}).`,
       `Hoy el equipo lleva ${amount} este mes.`]
    : [`El equipo ${alert.team_name} lleva ${amount} en ${month} (${nf.format(Math.floor(pct))} %).`,
       `La alerta avisa desde el ${alert.threshold_pct} %; no vuelve a avisar este mes.`]
  if (alert.alert_type === 'quota' || alert.budget_enforced) {
    lines.push('Al llegar al 100 % los gateways rechazan los pedidos del equipo hasta el mes siguiente.')
  }
  if (consoleUrl) lines.push(`Consola: ${consoleUrl}/teams`)
  return { subject, text: lines.join('\n') }
}

/**
 * Sends one message. `deps` lets tests replace fetch and the SMTP transport.
 * Throws with a short, storable reason.
 */
export async function deliver(alert, message, cfg = alertConfig(), deps = {}) {
  if (alert.channel === 'slack') {
    const problem = webhookProblem(alert.destination, cfg)
    if (problem) throw new Error(`webhook: ${problem}`)
    const fetchImpl = deps.fetch ?? fetch
    let res
    try {
      res = await fetchImpl(alert.destination, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: `*${message.subject}*\n${message.text}` }),
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
      })
    } catch (err) {
      throw new Error(`webhook: no se pudo conectar (${err?.cause?.code ?? err?.name ?? 'error'})`)
    }
    if (!res.ok) throw new Error(`webhook: respondió ${res.status}`)
    return
  }
  if (alert.channel === 'email') {
    if (!cfg.smtpUrl) throw new Error('email: falta configurar STRATUM_SMTP_URL en el control plane')
    const transport = deps.transport ?? await smtpTransport(cfg.smtpUrl)
    // A server that stops answering mid-conversation must not hold up the
    // other alerts of the round.
    let timer
    const limit = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('email: el servidor SMTP no respondió en 30 s')), deps.timeoutMs ?? 30_000)
    })
    try {
      await Promise.race([
        transport.sendMail({ from: cfg.from, to: alert.destination, subject: message.subject, text: message.text }),
        limit,
      ])
    } finally {
      clearTimeout(timer)
    }
    return
  }
  throw new Error(`canal desconocido: ${alert.channel}`)
}

let cachedTransport = null
async function smtpTransport(url) {
  if (cachedTransport?.url === url) return cachedTransport.t
  const { createTransport } = (await import('nodemailer')).default ?? await import('nodemailer')
  // smtps:// is TLS from the start; smtp:// upgrades with STARTTLS, and
  // requireTLS refuses a server that does not offer it.
  const secure = url.startsWith('smtps:')
  const t = createTransport(url, { requireTLS: !secure, connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 20_000 })
  cachedTransport = { url, t }
  return t
}

// The alerts to look at: active, of a team, quota or budget, not sent this
// month; with the team's limits and its usage this month.
const PENDING = `
  WITH month AS (SELECT date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS start)
  SELECT a.id, a.org_id, a.team_id, a.alert_type, a.threshold_pct, a.channel, a.destination,
         a.last_fired_at, t.name AS team_name,
         p.monthly_token_quota AS quota,
         COALESCE(t.monthly_budget_usd, p.monthly_budget_usd) AS budget,
         COALESCE(p.budget_enforced, false) AS budget_enforced
    FROM alerts a
    JOIN teams t ON t.id = a.team_id AND t.org_id = a.org_id
    LEFT JOIN policies p ON p.id = t.policy_id
   CROSS JOIN month
   WHERE a.is_active AND a.alert_type IN ('quota', 'budget')
     AND (a.last_fired_at IS NULL OR a.last_fired_at < month.start)`

export async function teamUsage(db, teamIds) {
  if (!teamIds.length) return new Map()
  const { rows } = await db.query(`
    SELECT team_id::text AS team_id,
           COALESCE(SUM(tokens_input + tokens_output), 0) AS tokens,
           COALESCE(SUM(cost_usd), 0) AS cost
      FROM request_logs
     WHERE team_id = ANY($1::uuid[])
       AND created_at >= date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
     GROUP BY team_id`, [teamIds])
  return new Map(rows.map(r => [r.team_id, r]))
}

/**
 * One round. Returns what happened to each alert that reached its threshold.
 */
export async function evaluateAlerts(db, { cfg = alertConfig(), deps = {}, now = new Date(), log = console } = {}) {
  // budget_enforced comes from migration 026 when it is there.
  let pending
  try {
    ({ rows: pending } = await db.query(PENDING))
  } catch (err) {
    if (err.code !== '42703') throw err // undefined column: an older schema
    ;({ rows: pending } = await db.query(PENDING.replace('COALESCE(p.budget_enforced, false)', 'false')))
  }
  const usage = await teamUsage(db, [...new Set(pending.map(a => a.team_id))])
  const results = []
  for (const alert of pending) {
    const hit = reached(alert, usage.get(alert.team_id))
    if (!hit) continue
    // Claim it: of several replicas, one sends.
    const { rowCount } = await db.query(`
      UPDATE alerts SET last_fired_at = now()
       WHERE id = $1 AND last_fired_at IS NOT DISTINCT FROM $2`, [alert.id, alert.last_fired_at])
    if (!rowCount) continue
    const message = buildMessage(alert, hit, { now, consoleUrl: cfg.consoleUrl })
    try {
      await deliver(alert, message, cfg, deps)
      await db.query('UPDATE alerts SET last_error = NULL, last_error_at = NULL WHERE id = $1', [alert.id])
      results.push({ id: alert.id, sent: true })
    } catch (err) {
      const reason = String(err?.message ?? err).slice(0, 300)
      await db.query(`
        UPDATE alerts SET last_fired_at = $2, last_error = $3, last_error_at = now() WHERE id = $1`,
        [alert.id, alert.last_fired_at, reason])
      log.error?.(`[alerts] ${alert.id} (${alert.team_name}): not sent: ${reason}`)
      results.push({ id: alert.id, sent: false, error: reason })
    }
  }
  return results
}
