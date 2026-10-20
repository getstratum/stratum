/**
 * GET /api/alerts/delivery — how this control plane sends alerts: whether
 * email is configured, the webhook hosts it posts to and how often it looks.
 */
export const dynamic = 'force-dynamic'
import { route, json } from '../../../../lib/route.js'
import { alertConfig } from '../../../../lib/alert-delivery.js'

export const GET = route('alerts.read', async () => {
  const cfg = alertConfig()
  return json({ email: !!cfg.smtpUrl, webhook_hosts: cfg.webhookHosts, interval_s: cfg.intervalS })
})
