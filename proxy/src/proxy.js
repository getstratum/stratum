import { checkPolicy }   from './policy.js'
import { logRequest }    from './logger.js'
import { getProviders }  from './providers.js'

// ─── SSE token extractor ──────────────────────────────────────────────────────

async function streamWithTokenCounting(providerRes, reply, provider) {
  const decoder = new TextDecoder()
  let buffer = '', inputTokens = 0, outputTokens = 0

  for await (const chunk of providerRes.body) {
    reply.raw.write(chunk)
    buffer += decoder.decode(chunk, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop()

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue
      const raw = line.slice(6).trim()
      if (raw === '[DONE]') continue
      try {
        const evt = JSON.parse(raw)
        if (provider === 'anthropic') {
          // Anthropic native SSE format
          if (evt.type === 'message_start') inputTokens  = evt.message?.usage?.input_tokens ?? inputTokens
          if (evt.type === 'message_delta') outputTokens = evt.usage?.output_tokens          ?? outputTokens
        } else {
          // OpenAI-compatible format: openai, google-gemini, groq, ollama, bonsai, etc.
          if (evt.usage) {
            inputTokens  = evt.usage.prompt_tokens     ?? inputTokens
            outputTokens = evt.usage.completion_tokens ?? outputTokens
          }
          // Fallback: count output tokens from delta content if usage not provided
          const delta = evt.choices?.[0]?.delta?.content
          if (delta && outputTokens === 0) {
            outputTokens += Math.ceil(delta.length / 4)
          }
        }
      } catch {}
    }
  }

  reply.raw.end()
  return { inputTokens, outputTokens }
}

// ─── Main handler ─────────────────────────────────────────────────────────────

export async function handleProxy(request, reply) {
  const { provider: rawProvider, '*': path } = request.params
  const { user, agent, team, policy, authMs = 0, requestStart } = request.ctx

  // ── Resolve effective provider ────────────────────────────────────────────
  let provider = rawProvider

  if (rawProvider === 'auto') {
    if (!agent?.default_provider) {
      return reply.code(400).send({
        error:   'no_model_configured',
        message: 'This agent has no default model configured. Set one in the Stratum dashboard.',
      })
    }
    provider = agent.default_provider
  }

  // Load providers dynamically from DB (cached 60s)
  const providers = await getProviders(this.db)
  const cfg = providers[provider]

  if (!cfg) {
    return reply.code(400).send({
      error:   'invalid_provider',
      message: `Provider "${provider}" not found or not active. Check the Providers page in the dashboard.`,
    })
  }

  // ── Model injection ───────────────────────────────────────────────────────
  // For agents with a configured model, always override what the caller sends.
  let body = request.body

  if (agent?.default_model) {
    body = { ...body, model: agent.default_model }
    request.log.info(
      { agentId: agent.id, injectedModel: agent.default_model },
      'model injected for agent'
    )
  }

  const model    = cfg.extractModel(body)
  const isStream = body.stream === true

  // ── Policy check ─────────────────────────────────────────────────────────
  const policyStart = Date.now()
  const policyError = await checkPolicy(this.redis, {
    team, policy, model,
    maxTokensRequested: body.max_tokens ?? 0,
  })

  const policyMs = Date.now() - policyStart

  if (policyError) {
    request.log.warn({ team: team?.name, model, ...policyError }, 'policy blocked request')
    return reply.code(policyError.code).send({
      error:   policyError.error,
      message: policyError.message,
    })
  }

  // ── Forward to provider ───────────────────────────────────────────────────
  // If base_url already contains a version segment (/v1beta/, /v2/, etc.),
  // strip the version prefix from the incoming path to avoid duplication.
  // e.g. Gemini: base=".../v1beta/openai" + path="v1/chat/completions"
  //              → ".../v1beta/openai/chat/completions"  (correct)
  // e.g. OpenAI: base="https://api.openai.com" + path="v1/chat/completions"
  //              → "https://api.openai.com/v1/chat/completions" (correct)
  const effectivePath = /\/v\d+[a-z]*\//.test(cfg.baseUrl)
    ? path.replace(/^v\d+[a-z]*\//, '')
    : path
  const targetUrl     = `${cfg.baseUrl}/${effectivePath}`
  const providerStart = Date.now()

  let providerRes
  try {
    providerRes = await fetch(targetUrl, {
      method:  'POST',
      headers: cfg.buildHeaders(),
      body:    JSON.stringify(isStream ? cfg.enrichStreamBody(body) : body),
    })
  } catch (err) {
    request.log.error({ err }, 'provider fetch failed')
    logRequest(this.db, this.redis, {
      orgId: user.org_id, teamId: team?.id, userId: agent ? null : user.id,
      agentId: agent?.id ?? null,
      provider, modelId: model, tokensInput: 0, tokensOutput: 0,
      statusCode: 502, latencyMs: Date.now() - (requestStart ?? providerStart),
      authMs, policyMs, providerMs: Date.now() - providerStart,
      isStream, errorMessage: err.message,
    })
    return reply.code(502).send({ error: 'provider_error', message: 'Could not reach AI provider' })
  }

  const providerMs  = Date.now() - providerStart
  const latencyMs   = Date.now() - (requestStart ?? providerStart)

  // ── Stream ────────────────────────────────────────────────────────────────
  if (isStream) {
    if (!providerRes.ok) {
      const errorBody = await providerRes.json().catch(() => ({
        error: 'provider_error', message: `Provider returned ${providerRes.status}`,
      }))
      logRequest(this.db, this.redis, {
        orgId: user.org_id, teamId: team?.id, userId: agent ? null : user.id,
        agentId: agent?.id ?? null,
        provider, modelId: model, tokensInput: 0, tokensOutput: 0,
        statusCode: providerRes.status, latencyMs, authMs, policyMs, providerMs: 0,
        isStream: true, errorMessage: JSON.stringify(errorBody),
      })
      return reply.code(providerRes.status).send(errorBody)
    }

    reply.raw.writeHead(200, {
      'Content-Type':                 'text/event-stream',
      'Cache-Control':                'no-cache',
      'Connection':                   'keep-alive',
      'Access-Control-Allow-Origin':  '*',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      'X-Gateway-Team':               team?.name   ?? 'unknown',
      'X-Gateway-Policy':             policy?.name ?? 'none',
      'X-Gateway-Model':              model,
      'X-Gateway-Latency':            String(latencyMs),
    })

    const { inputTokens, outputTokens } = await streamWithTokenCounting(providerRes, reply, provider)

    logRequest(this.db, this.redis, {
      orgId: user.org_id, teamId: team?.id, userId: agent ? null : user.id,
      agentId: agent?.id ?? null,
      provider, modelId: model,
      tokensInput: inputTokens, tokensOutput: outputTokens,
      statusCode: 200, latencyMs, authMs, policyMs, providerMs,
      isStream: true,
    })

    return
  }

  // ── Non-stream ────────────────────────────────────────────────────────────
  const responseBody = await providerRes.json()
  const usage = providerRes.ok ? cfg.extractUsage(responseBody) : { input: 0, output: 0 }

  logRequest(this.db, this.redis, {
    orgId: user.org_id, teamId: team?.id, userId: agent ? null : user.id,
    agentId: agent?.id ?? null,
    provider, modelId: model,
    tokensInput:  usage.input,
    tokensOutput: usage.output,
    statusCode: providerRes.status, latencyMs, isStream: false,
    errorMessage: providerRes.ok ? null : JSON.stringify(responseBody),
  })

  reply.header('X-Gateway-Team',    team?.name   ?? 'unknown')
  reply.header('X-Gateway-Policy',  policy?.name ?? 'none')
  reply.header('X-Gateway-Model',   model)
  reply.header('X-Gateway-Latency', String(latencyMs))

  return reply.code(providerRes.status).send(responseBody)
}
