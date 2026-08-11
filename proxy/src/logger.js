import { updateQuota } from './policy.js'
import { checkAlerts } from './alerter.js'

// In-memory model cost cache (refreshed every 10 min)
let modelCostCache = new Map()
let cacheExpiresAt = 0

/**
 * Log a completed request to Postgres and update Redis quota counters.
 * Fully asynchronous — errors here don't affect the user's response.
 */
export function logRequest(db, redis, params) {
  // Fire-and-forget: intentionally not awaited by the caller
  _log(db, redis, params).catch((err) =>
    console.error('[logger] Failed to log request:', err.message)
  )
}

async function _log(db, redis, {
  orgId,
  teamId,
  userId,
  agentId,
  provider,
  modelId,
  tokensInput,
  tokensOutput,
  statusCode,
  latencyMs,
  authMs,
  policyMs,
  providerMs,
  isStream,
  errorMessage,
}) {
  const tokensTotal = (tokensInput ?? 0) + (tokensOutput ?? 0)
  const costUsd = await estimateCost(db, provider, modelId, tokensInput, tokensOutput)

  // Write to Postgres
  await db.query(
    `INSERT INTO request_logs
       (org_id, team_id, user_id, agent_id, provider, model_id,
        tokens_input, tokens_output, cost_usd,
        status_code, latency_ms, auth_ms, policy_ms, provider_ms,
        is_stream, error_message)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
    [
      orgId, teamId, userId ?? null, agentId ?? null, provider, modelId,
      tokensInput ?? 0, tokensOutput ?? 0, costUsd,
      statusCode, latencyMs, authMs ?? null, policyMs ?? null, providerMs ?? null,
      isStream ?? false, errorMessage ?? null,
    ]
  )

  // Update Redis quota counters
  if (teamId && tokensTotal > 0) {
    await updateQuota(redis, { teamId, tokensUsed: tokensTotal, costUsd })

    // Check alert thresholds (fire-and-forget — never blocks logging)
    checkAlerts(db, redis, { teamId }).catch(err =>
      console.error('[alerter] check failed:', err.message)
    )
  }
}

// ─── Cost estimation ─────────────────────────────────────────────────────────

async function estimateCost(db, provider, modelId, tokensInput, tokensOutput) {
  const pricing = await getModelPricing(db, provider, modelId)
  if (!pricing) return 0

  const inputCost  = (tokensInput  / 1000) * parseFloat(pricing.cost_per_1k_input_tokens)
  const outputCost = (tokensOutput / 1000) * parseFloat(pricing.cost_per_1k_output_tokens)

  return inputCost + outputCost
}

async function getModelPricing(db, provider, modelId) {
  const cacheKey = `${provider}:${modelId}`

  if (Date.now() < cacheExpiresAt && modelCostCache.has(cacheKey)) {
    return modelCostCache.get(cacheKey)
  }

  // Refresh cache
  const { rows } = await db.query(
    `SELECT provider, model_id, cost_per_1k_input_tokens, cost_per_1k_output_tokens
     FROM ai_models WHERE is_active = true`
  )

  modelCostCache = new Map(rows.map((r) => [`${r.provider}:${r.model_id}`, r]))
  cacheExpiresAt = Date.now() + 10 * 60 * 1000 // 10 min

  return modelCostCache.get(cacheKey) ?? null
}
