import { getTeamUsage } from './policy.js'

const DEMO_ORG = '00000000-0000-0000-0000-000000000001'

/**
 * GET /metrics — Prometheus text format
 *
 * Computes metrics from:
 *   - Postgres: request counts, tokens, latency percentiles (last 24h)
 *   - Redis:    current-month quota usage per team (real-time)
 *
 * Scraped by Prometheus every 15s. Compatible with Grafana out of the box.
 */
export async function metricsRoute(request, reply) {
  const db    = this.db
  const redis = this.redis

  try {
    const lines = []

    // ── 1. Request counters ───────────────────────────────────────────────────
    const reqRows = await db.query(`
      SELECT
        COALESCE(t.name, 'unknown') AS team,
        r.provider,
        r.model_id                  AS model,
        r.status_code::text         AS status,
        COUNT(*)                    AS count
      FROM request_logs r
      LEFT JOIN teams t ON t.id = r.team_id
      WHERE r.created_at >= NOW() - INTERVAL '24 hours'
      GROUP BY t.name, r.provider, r.model_id, r.status_code
    `)

    lines.push('# HELP stratum_requests_total Total requests processed (last 24h)')
    lines.push('# TYPE stratum_requests_total counter')
    for (const r of reqRows.rows) {
      lines.push(
        `stratum_requests_total{team="${esc(r.team)}",provider="${r.provider}",model="${esc(r.model)}",status="${r.status}"} ${r.count}`
      )
    }

    // ── 2. Token counters ─────────────────────────────────────────────────────
    const tokenRows = await db.query(`
      SELECT
        COALESCE(t.name, 'unknown') AS team,
        r.provider,
        r.model_id                  AS model,
        SUM(r.tokens_input)         AS input_tokens,
        SUM(r.tokens_output)        AS output_tokens
      FROM request_logs r
      LEFT JOIN teams t ON t.id = r.team_id
      WHERE r.created_at >= NOW() - INTERVAL '24 hours'
      GROUP BY t.name, r.provider, r.model_id
    `)

    lines.push('\n# HELP stratum_tokens_total Total tokens consumed (last 24h)')
    lines.push('# TYPE stratum_tokens_total counter')
    for (const r of tokenRows.rows) {
      const lbl = `team="${esc(r.team)}",provider="${r.provider}",model="${esc(r.model)}"`
      lines.push(`stratum_tokens_total{${lbl},type="input"}  ${r.input_tokens  ?? 0}`)
      lines.push(`stratum_tokens_total{${lbl},type="output"} ${r.output_tokens ?? 0}`)
    }

    // ── 3. Cost ───────────────────────────────────────────────────────────────
    const costRows = await db.query(`
      SELECT
        COALESCE(t.name, 'unknown') AS team,
        r.model_id                  AS model,
        SUM(r.cost_usd)             AS cost
      FROM request_logs r
      LEFT JOIN teams t ON t.id = r.team_id
      WHERE r.created_at >= NOW() - INTERVAL '24 hours'
      GROUP BY t.name, r.model_id
    `)

    lines.push('\n# HELP stratum_cost_usd_total Estimated cost in USD (last 24h)')
    lines.push('# TYPE stratum_cost_usd_total counter')
    for (const r of costRows.rows) {
      lines.push(
        `stratum_cost_usd_total{team="${esc(r.team)}",model="${esc(r.model)}"} ${parseFloat(r.cost ?? 0).toFixed(8)}`
      )
    }

    // ── 4. Latency percentiles ────────────────────────────────────────────────
    const latRows = await db.query(`
      SELECT
        COALESCE(t.name, 'unknown')                                  AS team,
        PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY r.latency_ms)  AS p50,
        PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY r.latency_ms)  AS p95,
        PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY r.latency_ms)  AS p99,
        PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY r.auth_ms)     AS auth_p95,
        PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY r.policy_ms)   AS policy_p95,
        PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY r.provider_ms) AS provider_p95,
        COUNT(*)                                                      AS count
      FROM request_logs r
      LEFT JOIN teams t ON t.id = r.team_id
      WHERE r.created_at >= NOW() - INTERVAL '24 hours'
        AND r.latency_ms IS NOT NULL
      GROUP BY t.name
    `)

    lines.push('\n# HELP stratum_request_duration_ms Request end-to-end latency (last 24h)')
    lines.push('# TYPE stratum_request_duration_ms gauge')
    for (const r of latRows.rows) {
      const lbl = `team="${esc(r.team)}"`
      lines.push(`stratum_request_duration_ms{${lbl},quantile="0.5"}  ${Math.round(r.p50  ?? 0)}`)
      lines.push(`stratum_request_duration_ms{${lbl},quantile="0.95"} ${Math.round(r.p95  ?? 0)}`)
      lines.push(`stratum_request_duration_ms{${lbl},quantile="0.99"} ${Math.round(r.p99  ?? 0)}`)
    }

    lines.push('\n# HELP stratum_auth_duration_ms Auth stage p95 latency (last 24h)')
    lines.push('# TYPE stratum_auth_duration_ms gauge')
    for (const r of latRows.rows) {
      if (r.auth_p95 != null) {
        lines.push(`stratum_auth_duration_ms{team="${esc(r.team)}"} ${Math.round(r.auth_p95)}`)
      }
    }

    lines.push('\n# HELP stratum_policy_check_duration_ms Policy check p95 latency (last 24h)')
    lines.push('# TYPE stratum_policy_check_duration_ms gauge')
    for (const r of latRows.rows) {
      if (r.policy_p95 != null) {
        lines.push(`stratum_policy_check_duration_ms{team="${esc(r.team)}"} ${Math.round(r.policy_p95)}`)
      }
    }

    lines.push('\n# HELP stratum_provider_duration_ms Provider call p95 latency (last 24h)')
    lines.push('# TYPE stratum_provider_duration_ms gauge')
    for (const r of latRows.rows) {
      if (r.provider_p95 != null) {
        lines.push(`stratum_provider_duration_ms{team="${esc(r.team)}"} ${Math.round(r.provider_p95)}`)
      }
    }

    // ── 5. Quota ratios (real-time from Redis) ────────────────────────────────
    const teamRows = await db.query(`
      SELECT t.id, t.name,
             p.monthly_token_quota, p.monthly_budget_usd
      FROM teams t
      LEFT JOIN policies p ON p.id = t.policy_id
      WHERE t.org_id = $1
    `, [DEMO_ORG])

    lines.push('\n# HELP stratum_token_quota_ratio Current month token usage ratio (0-1)')
    lines.push('# TYPE stratum_token_quota_ratio gauge')
    lines.push('\n# HELP stratum_budget_quota_ratio Current month budget usage ratio (0-1)')
    lines.push('# TYPE stratum_budget_quota_ratio gauge')

    for (const team of teamRows.rows) {
      const usage    = await getTeamUsage(redis, team.id)
      const tokenLim = parseInt(team.monthly_token_quota ?? 0)
      const costLim  = parseFloat(team.monthly_budget_usd ?? 0)
      const lbl      = `team="${esc(team.name)}"`

      if (tokenLim > 0) {
        const ratio = Math.min(1, usage.tokens_used / tokenLim)
        lines.push(`stratum_token_quota_ratio{${lbl}} ${ratio.toFixed(4)}`)
      }
      if (costLim > 0) {
        const ratio = Math.min(1, usage.cost_usd / costLim)
        lines.push(`stratum_budget_quota_ratio{${lbl}} ${ratio.toFixed(4)}`)
      }
    }

    // ── 6. Error rate ─────────────────────────────────────────────────────────
    const errRows = await db.query(`
      SELECT
        COALESCE(t.name, 'unknown')                                        AS team,
        ROUND(AVG(CASE WHEN r.status_code >= 400 THEN 1.0 ELSE 0.0 END) * 100, 2) AS error_pct
      FROM request_logs r
      LEFT JOIN teams t ON t.id = r.team_id
      WHERE r.created_at >= NOW() - INTERVAL '1 hour'
      GROUP BY t.name
    `)

    lines.push('\n# HELP stratum_error_rate_pct Percentage of requests returning 4xx/5xx (last 1h)')
    lines.push('# TYPE stratum_error_rate_pct gauge')
    for (const r of errRows.rows) {
      lines.push(`stratum_error_rate_pct{team="${esc(r.team)}"} ${r.error_pct ?? 0}`)
    }

    reply
      .header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
      .send(lines.join('\n') + '\n')

  } catch (err) {
    request.log.error({ err }, '/metrics error')
    reply.code(500).send('# ERROR computing metrics\n')
  }
}

// Escape label values for Prometheus
function esc(s) {
  return String(s ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')
}
