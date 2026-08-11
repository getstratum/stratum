# Architecture

> 📖 [Leer en español](../es/arquitectura.md)

## Overview

Stratum uses a **split-plane architecture**: the control plane (dashboard + policy management) runs in your cloud, while the data plane (proxy gateway) runs inside the customer's network. Prompts flow directly from the gateway to the AI provider — they never reach the control plane.

```
┌──────────────────────────────────────────────────────┐
│                   Control Plane                       │
│  Dashboard (Next.js) · Policies · Analytics          │
└─────────────────────┬────────────────────────────────┘
                      │ Metadata only (no prompt content)
┌─────────────────────▼────────────────────────────────┐
│                   Data Plane                          │  ← Customer's network
│                                                      │
│  ┌─────────────────────────────────────────────┐    │
│  │           AI Gateway (Fastify)               │    │
│  │  Auth → Policy → [Model inject] → Proxy      │    │
│  └────────┬──────────────────┬──────────────────┘    │
│           │                  │                        │
│  ┌────────▼──────┐  ┌────────▼──────┐                │
│  │    Redis       │  │  PostgreSQL   │                │
│  │  (quotas)      │  │   (logs)      │                │
│  └────────────────┘  └───────────────┘                │
│                                                      │
│  ┌─────────────┐                                     │
│  │   Ollama     │  ← optional, for context compression│
│  │  llama3.2:1b │                                    │
│  └─────────────┘                                     │
└──────────────────────────────────────────────────────┘
          │
   ┌──────┴───────┐
   ▼              ▼
OpenAI API   Anthropic API   Gemini API   …
```

---

## Request pipeline

Every API call passes through the same pipeline:

```
1. Auth         (~5-15ms)   API key / agent key / JWT → user + team + policy
2. Policy        (<5ms)     Redis: model allowed? quota ok? budget ok?
3. Model inject  (<1ms)     For agents: override body.model with configured model
4. Provider      (network)  Forward to OpenAI / Anthropic / Gemini / Ollama
5. Log async     (~50ms)    INSERT request_logs + INCR Redis counters (non-blocking)
```

Redis handles the hot path (auth cache + quota check) in under 5ms. PostgreSQL receives the log entry asynchronously after the response is already sent.

---

## Authentication — three token types

| Token | Format | Lookup | Use case |
|-------|--------|--------|----------|
| Developer key | `aig_sk_...` | SHA-256 → `users` table | Developers, CI/CD, SDKs |
| Agent key | `aig_agt_...` | SHA-256 → `agents` table | Automated processes, bots |
| Session JWT | `xxx.yyy.zzz` | jose HMAC-HS256 | Playground, dashboard |

All three resolve to the same pipeline: user → team → policy. The distinction matters for:
- **Logging**: `user_id` vs `agent_id` in `request_logs`
- **Model injection**: agent keys trigger automatic model override
- **Dashboard access**: agent keys cannot log in to the UI

---

## Dashboard access model

A separate Next.js middleware layer protects the admin dashboard:

```
Request to /            → middleware checks stratum_session cookie
  └── No cookie         → redirect to /login
  └── Valid, Engineering → allow through to dashboard
  └── Valid, other team  → redirect to /prompt (Playground)

/prompt                 → always public (has its own proxy-based auth)
/login                  → always public
/api/session            → always public (creates/destroys the session)
/metrics                → always public (for Prometheus scraping)
```

The session cookie is:
- httpOnly (not accessible from JavaScript)
- Signed with `SESSION_SECRET` (jose HS256)
- 24h expiry
- `secure` flag only when `SECURE_COOKIES=true` (requires HTTPS)

---

## Agent model injection

When a request arrives with an `aig_agt_` key:

1. Auth resolves the agent and loads `default_model` + `default_provider` from DB
2. Proxy overrides `body.model` with `agent.default_model`
3. For `/proxy/auto/` requests, proxy routes to `agent.default_provider`

This means agents have zero knowledge of which model or provider they use. Admins change the model in the dashboard — no agent code changes, no redeployment.

---

## Token counting in streaming

The gateway parses SSE chunks while simultaneously streaming them to the client:

```
SSE chunk arrives from provider
    ↓
Write chunk to client (immediately)     ← zero added latency
    ↓ (parallel)
Parse chunk for token usage             ← accumulate counts
    ↓ (after stream ends)
Log with real token counts to DB
```

**All OpenAI-compatible providers** (OpenAI, Gemini, Groq, Ollama, Bonsai) use the same SSE format — `evt.usage.prompt_tokens` and `evt.usage.completion_tokens` in the final chunk (with `stream_options: { include_usage: true }`).

**Anthropic** uses its own format: `message_start` event for input tokens, `message_delta` for output tokens.

A char-count fallback (`~4 chars/token`) is used when usage data is missing from the stream.

---

## Provider management

Providers are stored in the `providers` DB table. The proxy loads them with a 60-second in-memory cache. Adding or disabling a provider is a data operation — no code changes, no proxy restart (takes effect within 60 seconds).

```sql
providers (
  slug VARCHAR,          -- 'openai', 'google-gemini', 'groq', ...
  display_name VARCHAR,
  base_url VARCHAR,      -- 'https://api.openai.com'
  api_type VARCHAR,      -- 'openai-compatible' | 'anthropic' | 'aws-bedrock'
  api_key_env VARCHAR,   -- env var name: 'OPENAI_API_KEY'
  is_active BOOLEAN,
  notes TEXT
)
```

**URL construction:** `targetUrl = base_url + "/" + effectivePath`

For providers with versioned base URLs (e.g., Gemini's `/v1beta/openai`), the `/v1/` prefix is automatically stripped from the path to avoid duplication.

---

## Context compression

When enabled in the Playground, a local LLM (Ollama) summarizes older messages:

```
First 6 messages → sent normally to provider

Message 7+ → Stratum compresses:
  toCompress = messages[0 .. n-4]   (older messages)
  toKeep     = messages[n-4 .. n]   (last 4, always fresh)

  call Ollama llama3.2:1b → summary (~100-200 tokens)

  sent to provider = [summaryMsg, ackMsg, ...toKeep, userMsg]
```

**Rolling summary**: Ollama is only called at first compression (≥6 messages) and re-compression (≥10 recent messages after last summary). Between compressions, the existing summary is reused — zero Ollama calls, zero added latency.

The `keep_alive: -1` parameter keeps the model loaded in RAM after the first call. Subsequent compressions are fast (~1-2s on CPU for a 1B model).

---

## Database schema

```
Organization
  └── Team (has Policy)
        ├── User (api_key_hash | password_hash | both)
        └── Agent (api_key_hash, default_model, default_provider)

Policy
  ├── allowed_models: TEXT[]
  ├── max_tokens_per_request: INTEGER
  ├── monthly_token_quota: BIGINT
  └── monthly_budget_usd: DECIMAL

RequestLog (partitioned by month)
  ├── org_id, team_id
  ├── user_id    (null for agent requests)
  ├── agent_id   (null for human requests)
  ├── provider, model_id
  ├── tokens_input, tokens_output, cost_usd
  ├── auth_ms, policy_ms, provider_ms   (per-stage timing)
  ├── trace_id, status_code, latency_ms
  └── created_at

Provider
  ├── slug, display_name, base_url
  ├── api_type, api_key_env
  └── is_active, notes

Agent
  ├── team_id, name, description
  ├── api_key_hash, api_key_prefix
  ├── default_model, default_provider
  └── is_active
```

All migrations are idempotent (safe to re-run). Run with:

```bash
docker exec -it $(docker compose ps -q proxy) node /app/src/migrate.js
```
