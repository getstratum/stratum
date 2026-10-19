export const dynamic = 'force-dynamic'
import { route, json } from '../../../lib/route.js'
import { parseDateRange, logsScope } from '../../../lib/usage.js'

export const GET = route('usage.read', async (req, { session, db }) => {
  const { from, to } = parseDateRange(new URL(req.url).searchParams)
  const scoped = () => {
    const params = [from, to]
    return { params, where: `r.created_at >= $1 AND r.created_at <= $2 AND ${logsScope(session, 'r', params)}` }
  }
  const a = scoped(), b = scoped(), c = scoped()

  const [byProvider, byModel, byTeamProvider] = await Promise.all([
    db.query(`
      SELECT provider,
             COUNT(*)                                        AS requests,
             COALESCE(SUM(tokens_input + tokens_output), 0) AS tokens,
             COALESCE(SUM(cost_usd), 0)                     AS cost,
             COALESCE(AVG(latency_ms), 0)                   AS avg_latency,
             COUNT(CASE WHEN status_code >= 400 THEN 1 END) AS errors
        FROM request_logs r
       WHERE ${a.where}
       GROUP BY provider
       ORDER BY cost DESC
    `, a.params),
    db.query(`
      SELECT provider, model_id,
             COUNT(*)                        AS requests,
             COALESCE(SUM(tokens_input), 0)  AS tokens_input,
             COALESCE(SUM(tokens_output), 0) AS tokens_output,
             COALESCE(SUM(cost_usd), 0)      AS cost,
             COALESCE(AVG(latency_ms), 0)    AS avg_latency
        FROM request_logs r
       WHERE ${b.where}
       GROUP BY provider, model_id
       ORDER BY cost DESC
       LIMIT 10
    `, b.params),
    db.query(`
      SELECT COALESCE(t.name, 'Equipo eliminado') AS team, r.provider,
             COALESCE(SUM(r.cost_usd), 0) AS cost,
             COUNT(*) AS requests
        FROM request_logs r
        -- A deleted team's requests stay in the totals.
        LEFT JOIN teams t ON t.id = r.team_id AND t.org_id = r.org_id
       WHERE ${c.where}
       GROUP BY 1, r.provider
       ORDER BY 1, cost DESC
    `, c.params),
  ])

  return json({
    byProvider: byProvider.rows.map(r => ({
      provider:   r.provider,
      requests:   parseInt(r.requests),
      tokens:     parseInt(r.tokens),
      cost:       parseFloat(r.cost),
      avgLatency: Math.round(parseFloat(r.avg_latency)),
      errors:     parseInt(r.errors),
    })),
    byModel: byModel.rows.map(r => ({
      provider:     r.provider,
      model:        r.model_id,
      requests:     parseInt(r.requests),
      tokensInput:  parseInt(r.tokens_input),
      tokensOutput: parseInt(r.tokens_output),
      cost:         parseFloat(r.cost),
      avgLatency:   Math.round(parseFloat(r.avg_latency)),
    })),
    byTeamProvider: byTeamProvider.rows.map(r => ({
      team:     r.team,
      provider: r.provider,
      cost:     parseFloat(r.cost),
      requests: parseInt(r.requests),
    })),
  })
})
