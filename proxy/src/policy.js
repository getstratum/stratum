/**
 * Policy enforcement
 *
 * Redis keys (reset automatically via TTL at month boundary):
 *   quota:tokens:{teamId}:{YYYY-MM}  →  total input+output tokens this month
 *   quota:cost:{teamId}:{YYYY-MM}    →  total cost in micro-USD (×1,000,000)
 */

// ─── Check ────────────────────────────────────────────────────────────────────

/**
 * Returns null if all checks pass, or an error object to send back as 403/429.
 */
export async function checkPolicy(redis, { team, policy, model, maxTokensRequested }) {
  // 1. Model whitelist
  if (policy?.allowed_models?.length > 0) {
    if (!policy.allowed_models.includes(model)) {
      return {
        code: 403,
        error: 'policy_violation',
        message: `Model "${model}" is not allowed for team "${team?.name}". Allowed: ${policy.allowed_models.join(', ')}`,
      }
    }
  }

  // 2. Per-request token cap
  if (policy?.max_tokens_per_request && maxTokensRequested > policy.max_tokens_per_request) {
    return {
      code: 403,
      error: 'policy_violation',
      message: `Requested max_tokens (${maxTokensRequested}) exceeds team limit of ${policy.max_tokens_per_request}`,
    }
  }

  // 3. Monthly token quota (Redis)
  if (team?.id && policy?.monthly_token_quota) {
    const tokenKey = redisKey('tokens', team.id)
    const used = parseInt(await redis.get(tokenKey) ?? '0', 10)

    if (used >= policy.monthly_token_quota) {
      return {
        code: 429,
        error: 'quota_exceeded',
        message: `Team "${team.name}" has reached its monthly token quota of ${policy.monthly_token_quota.toLocaleString()} tokens`,
      }
    }
  }

  // 4. Monthly budget quota (Redis, stored in micro-USD to avoid floats)
  if (team?.id && policy?.monthly_budget_usd) {
    const costKey = redisKey('cost', team.id)
    const usedMicro = parseInt(await redis.get(costKey) ?? '0', 10)
    const usedUsd = usedMicro / 1_000_000
    const budgetUsd = parseFloat(policy.monthly_budget_usd)

    if (usedUsd >= budgetUsd) {
      return {
        code: 429,
        error: 'budget_exceeded',
        message: `Team "${team.name}" has reached its monthly budget of $${budgetUsd.toFixed(2)}`,
      }
    }
  }

  return null // all clear
}

// ─── Update ───────────────────────────────────────────────────────────────────

/**
 * Atomically increment token + cost counters after a successful request.
 * Called asynchronously — never blocks the response.
 */
export async function updateQuota(redis, { teamId, tokensUsed, costUsd }) {
  if (!teamId) return

  const tokenKey = redisKey('tokens', teamId)
  const costKey  = redisKey('cost',   teamId)
  const ttl      = secondsUntilEndOfMonth()

  const pipeline = redis.pipeline()
  pipeline.incrby(tokenKey, tokensUsed)
  pipeline.expire(tokenKey, ttl)
  pipeline.incrby(costKey, Math.round(costUsd * 1_000_000))
  pipeline.expire(costKey, ttl)

  await pipeline.exec()
}

// ─── Current usage (for dashboard API) ───────────────────────────────────────

export async function getTeamUsage(redis, teamId) {
  const tokenKey = redisKey('tokens', teamId)
  const costKey  = redisKey('cost',   teamId)

  const [tokensRaw, costRaw] = await redis.mget(tokenKey, costKey)

  return {
    tokens_used: parseInt(tokensRaw ?? '0', 10),
    cost_usd:    parseInt(costRaw ?? '0', 10) / 1_000_000,
    period:      currentPeriod(),
  }
}

// ─── Utils ────────────────────────────────────────────────────────────────────

function currentPeriod() {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
}

function redisKey(type, teamId) {
  return `quota:${type}:${teamId}:${currentPeriod()}`
}

function secondsUntilEndOfMonth() {
  const now = new Date()
  const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1)
  return Math.ceil((endOfMonth - now) / 1000) + 86_400 // +1 day buffer
}
