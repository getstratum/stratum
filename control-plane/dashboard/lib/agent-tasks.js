/**
 * An agent's results (the gateway's ADR-0019): its tasks, each named by
 * X-Stratum-Task on its requests and ended by the application with an
 * outcome (task_outcomes). What a person in charge of agents measures one
 * by, rather than tokens: how many tasks it resolves on its own, how many
 * it hands over to a person, how many fail, what a task costs and takes.
 *
 * A task counts in a window when it ended in it; its last outcome counts
 * (a task may be reopened). Its cost and time are its requests' up to that
 * end, looked for up to 30 days before the window. A task with requests in
 * the window and no outcome ever is open: either still going, or the
 * application does not say how its tasks end.
 */

export const WINDOWS = [7, 30, 90]
const LOOKBACK_DAYS = 30

const num = (v) => (v === null || v === undefined ? null : Number(v))
const rate = (part, whole) => (whole ? Math.round((1000 * part) / whole) / 10 : null)

function summaryOf(row, open) {
  const closed = Number(row?.closed ?? 0)
  const resolved = Number(row?.resolved ?? 0)
  const escalated = Number(row?.escalated ?? 0)
  const cost = num(row?.cost)
  return {
    closed, resolved, escalated, failed: Number(row?.failed ?? 0), open: Number(open ?? 0),
    resolution_rate: rate(resolved, closed),
    escalation_rate: rate(escalated, closed),
    cost_usd: cost,
    cost_per_task: closed && cost !== null ? Math.round((cost / closed) * 1e6) / 1e6 : null,
    unpriced_requests: Number(row?.unpriced ?? 0),
    requests_per_task: closed ? Math.round((10 * Number(row?.requests ?? 0)) / closed) / 10 : null,
    avg_seconds: row?.avg_seconds === null || row?.avg_seconds === undefined ? null : Math.round(Number(row.avg_seconds)),
  }
}

// The last outcome of each task that ended in the window, with its requests.
const ENDED = `
  WITH last AS (
    SELECT DISTINCT ON (o.agent_id, o.task) o.agent_id, o.task, o.outcome, o.reason, o.created_at AS ended_at
      FROM task_outcomes o
     WHERE o.org_id = $1 AND o.agent_id = ANY($2::uuid[])
       AND o.created_at >= now() - make_interval(days => $3)
     ORDER BY o.agent_id, o.task, o.created_at DESC
  ), spent AS (
    SELECT l.agent_id, l.task, count(r.id) AS requests, sum(r.cost_usd) AS cost,
           count(r.id) FILTER (WHERE r.cost_usd IS NULL) AS unpriced, min(r.created_at) AS started_at
      FROM last l
      LEFT JOIN request_logs r ON r.org_id = $1 AND r.agent_id = l.agent_id AND r.task = l.task
                              AND r.created_at >= now() - make_interval(days => $3 + ${LOOKBACK_DAYS})
                              AND r.created_at <= l.ended_at
     GROUP BY l.agent_id, l.task
  )`

/** Each agent's summary over the last `days`: { [agentId]: summary }. */
export async function summaries(db, orgId, agentIds, days = 30) {
  const out = {}
  if (!agentIds.length) return out
  const [{ rows }, { rows: open }] = await Promise.all([
    db.query(`${ENDED}
      SELECT l.agent_id::text AS agent_id, count(*) AS closed,
             count(*) FILTER (WHERE l.outcome = 'resolved')  AS resolved,
             count(*) FILTER (WHERE l.outcome = 'escalated') AS escalated,
             count(*) FILTER (WHERE l.outcome = 'failed')    AS failed,
             sum(s.cost) AS cost, sum(s.unpriced) AS unpriced, sum(s.requests) AS requests,
             avg(extract(epoch FROM l.ended_at - s.started_at)) FILTER (WHERE s.started_at IS NOT NULL) AS avg_seconds
        FROM last l JOIN spent s USING (agent_id, task)
       GROUP BY l.agent_id`, [orgId, agentIds, days]),
    db.query(`
      SELECT r.agent_id::text AS agent_id, count(DISTINCT r.task) AS open
        FROM request_logs r
       WHERE r.org_id = $1 AND r.agent_id = ANY($2::uuid[]) AND r.task IS NOT NULL
         AND r.created_at >= now() - make_interval(days => $3)
         AND NOT EXISTS (SELECT 1 FROM task_outcomes o WHERE o.org_id = $1 AND o.agent_id = r.agent_id AND o.task = r.task)
       GROUP BY r.agent_id`, [orgId, agentIds, days]),
  ])
  const byAgent = new Map(rows.map(r => [r.agent_id, r]))
  const openBy = new Map(open.map(r => [r.agent_id, r.open]))
  for (const id of agentIds) out[id] = summaryOf(byAgent.get(id), openBy.get(id))
  return out
}

/**
 * One agent over the last `days`: { days, summary, reasons, recent, open }.
 * reasons: why tasks were escalated or failed, most common first; recent:
 * the last 20 tasks that ended; open: the last 10 without an outcome.
 */
export async function detail(db, orgId, agentId, days = 30) {
  const [summary, { rows: reasons }, { rows: recent }, { rows: open }] = await Promise.all([
    summaries(db, orgId, [agentId], days),
    db.query(`${ENDED}
      SELECT l.outcome, COALESCE(l.reason, '') AS reason, count(*) AS n
        FROM last l WHERE l.outcome <> 'resolved'
       GROUP BY l.outcome, l.reason ORDER BY n DESC, l.outcome LIMIT 10`, [orgId, [agentId], days]),
    db.query(`${ENDED}
      SELECT l.task, l.outcome, l.reason, l.ended_at, s.requests, s.cost, s.unpriced,
             extract(epoch FROM l.ended_at - s.started_at) AS seconds
        FROM last l JOIN spent s USING (agent_id, task)
       ORDER BY l.ended_at DESC LIMIT 20`, [orgId, [agentId], days]),
    db.query(`
      SELECT r.task, count(*) AS requests, sum(r.cost_usd) AS cost, min(r.created_at) AS started_at, max(r.created_at) AS last_at
        FROM request_logs r
       WHERE r.org_id = $1 AND r.agent_id = $2 AND r.task IS NOT NULL
         AND r.created_at >= now() - make_interval(days => $3)
         AND NOT EXISTS (SELECT 1 FROM task_outcomes o WHERE o.org_id = $1 AND o.agent_id = r.agent_id AND o.task = r.task)
       GROUP BY r.task ORDER BY last_at DESC LIMIT 10`, [orgId, agentId, days]),
  ])
  return {
    days,
    summary: summary[agentId],
    reasons: reasons.map(r => ({ outcome: r.outcome, reason: r.reason || null, count: Number(r.n) })),
    recent: recent.map(r => ({
      task: r.task, outcome: r.outcome, reason: r.reason, ended_at: r.ended_at, requests: Number(r.requests),
      cost_usd: num(r.cost), unpriced_requests: Number(r.unpriced), seconds: r.seconds === null ? null : Math.round(Number(r.seconds)),
    })),
    open: open.map(r => ({ task: r.task, requests: Number(r.requests), cost_usd: num(r.cost), started_at: r.started_at, last_at: r.last_at })),
  }
}
