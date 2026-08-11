import nodemailer from 'nodemailer'
import { getTeamUsage } from './policy.js'

// ─── Email transporter (lazy-initialized) ────────────────────────────────────

let _transporter = null

function getTransporter() {
  if (_transporter) return _transporter

  if (!process.env.SMTP_HOST) return null   // email not configured

  _transporter = nodemailer.createTransport({
    host:   process.env.SMTP_HOST,
    port:   parseInt(process.env.SMTP_PORT ?? '587'),
    secure: process.env.SMTP_SECURE === 'true',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  })

  return _transporter
}

// ─── Main entry point ─────────────────────────────────────────────────────────
// Called from logger.js after each successful request (fire-and-forget).

export async function checkAlerts(db, redis, { teamId }) {
  if (!teamId) return

  // Load active alerts + team policy limits in one query
  const { rows: alerts } = await db.query(`
    SELECT
      a.id, a.alert_type, a.threshold_pct, a.channel, a.destination, a.last_fired_at,
      t.name AS team_name,
      p.monthly_budget_usd,
      p.monthly_token_quota
    FROM alerts a
    JOIN  teams    t ON t.id = a.team_id
    LEFT JOIN policies p ON p.id = t.policy_id
    WHERE a.team_id = $1 AND a.is_active = true
  `, [teamId])

  if (!alerts.length) return

  // Current month usage from Redis
  const usage = await getTeamUsage(redis, teamId)

  for (const alert of alerts) {

    // ── Dedup: fire at most once per day per alert ────────────────────────────
    if (alert.last_fired_at) {
      const lastFired = new Date(alert.last_fired_at)
      const today     = new Date()
      if (
        lastFired.getFullYear() === today.getFullYear() &&
        lastFired.getMonth()    === today.getMonth()    &&
        lastFired.getDate()     === today.getDate()
      ) continue
    }

    // ── Calculate current usage % ─────────────────────────────────────────────
    let pct        = 0
    let usedLabel  = '—'
    let limitLabel = '—'

    if (alert.alert_type === 'budget') {
      const limit = parseFloat(alert.monthly_budget_usd ?? 0)
      if (limit <= 0) continue
      pct        = (usage.cost_usd / limit) * 100
      usedLabel  = `$${usage.cost_usd.toFixed(4)}`
      limitLabel = `$${limit.toFixed(0)}`

    } else if (alert.alert_type === 'quota') {
      const limit = parseInt(alert.monthly_token_quota ?? 0)
      if (limit <= 0) continue
      pct        = (usage.tokens_used / limit) * 100
      usedLabel  = `${(usage.tokens_used / 1000).toFixed(1)}K tokens`
      limitLabel = `${(limit / 1_000_000).toFixed(1)}M tokens`
    }

    if (pct < alert.threshold_pct) continue   // threshold not crossed yet

    // ── Fire ──────────────────────────────────────────────────────────────────
    const context = {
      teamName:   alert.team_name,
      alertType:  alert.alert_type,
      pct:        pct.toFixed(0),
      threshold:  alert.threshold_pct,
      usedLabel,
      limitLabel,
      period:     usage.period,
    }

    if (alert.channel === 'email') {
      await sendEmail(alert.destination, context).catch(err =>
        console.error(`[alerter] email failed for alert ${alert.id}:`, err.message)
      )
    } else if (alert.channel === 'slack') {
      await sendSlack(alert.destination, context).catch(err =>
        console.error(`[alerter] slack failed for alert ${alert.id}:`, err.message)
      )
    }

    await db.query(
      'UPDATE alerts SET last_fired_at = NOW() WHERE id = $1',
      [alert.id]
    )
  }
}

// ─── Email ────────────────────────────────────────────────────────────────────

async function sendEmail(to, ctx) {
  const transport = getTransporter()
  if (!transport) {
    console.warn('[alerter] SMTP not configured — skipping email alert')
    return
  }

  const subject = `[Stratum] ${ctx.teamName} reached ${ctx.pct}% of ${ctx.alertType} limit`

  const html = `
    <div style="font-family: -apple-system, sans-serif; max-width: 520px; margin: 0 auto; padding: 32px;">
      <div style="margin-bottom: 24px;">
        <span style="font-size: 11px; font-weight: 700; letter-spacing: 2px; text-transform: uppercase; color: #999;">
          Stratum · AI Governance
        </span>
      </div>

      <h2 style="font-size: 22px; font-weight: 700; color: #0f0f12; margin: 0 0 8px;">
        ${ctx.alertType === 'budget' ? '💰' : '🔢'}
        ${ctx.teamName} at ${ctx.pct}% of ${ctx.alertType === 'budget' ? 'monthly budget' : 'token quota'}
      </h2>

      <p style="color: #555; font-size: 15px; line-height: 1.6; margin: 16px 0 24px;">
        The <strong>${ctx.teamName}</strong> team has used
        <strong>${ctx.usedLabel}</strong> out of
        <strong>${ctx.limitLabel}</strong> this month (${ctx.period}).
        ${parseInt(ctx.pct) >= 100
          ? 'They have <strong>reached the limit</strong> and are now blocked.'
          : `At this rate they will hit the limit before month end.`}
      </p>

      <div style="background: #f4f4f0; border-radius: 8px; padding: 16px 20px; margin-bottom: 24px;">
        <div style="font-size: 13px; color: #555; margin-bottom: 6px;">Threshold configured</div>
        <div style="font-size: 24px; font-weight: 700; color: #0f0f12;">${ctx.pct}% / ${ctx.threshold}% alert</div>
      </div>

      <p style="color: #999; font-size: 12px;">
        You're receiving this because you configured an alert for this team in Stratum.
        To manage alerts, open the Stratum dashboard.
      </p>
    </div>
  `

  await transport.sendMail({
    from:    process.env.SMTP_FROM ?? 'Stratum <noreply@proxima.ai>',
    to,
    subject,
    html,
  })
}

// ─── Slack ────────────────────────────────────────────────────────────────────

async function sendSlack(webhookUrl, ctx) {
  const emoji    = ctx.alertType === 'budget' ? '💰' : '🔢'
  const critical = parseInt(ctx.pct) >= 100

  const body = {
    blocks: [
      {
        type: 'header',
        text: {
          type: 'plain_text',
          text: `${emoji} ${ctx.teamName} · ${ctx.pct}% of ${ctx.alertType === 'budget' ? 'budget' : 'token quota'}`,
        },
      },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*Team*\n${ctx.teamName}` },
          { type: 'mrkdwn', text: `*Period*\n${ctx.period}` },
          { type: 'mrkdwn', text: `*Used*\n${ctx.usedLabel}` },
          { type: 'mrkdwn', text: `*Limit*\n${ctx.limitLabel}` },
        ],
      },
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: critical
              ? `🚨 Limit reached — team is now *blocked* from making AI requests`
              : `Alert fired at ${ctx.threshold}% threshold · Stratum AI Governance`,
          },
        ],
      },
    ],
  }

  const res = await fetch(webhookUrl, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  })

  if (!res.ok) {
    throw new Error(`Slack webhook returned ${res.status}`)
  }
}
