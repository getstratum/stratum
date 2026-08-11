# API Reference

> 📖 [Leer en español](../es/referencia-api.md)

The Stratum gateway runs on port `8080`. All requests require a `Bearer` token except `/health`, `/auth/login`, and `/metrics`.

---

## Authentication

Three token types are accepted:

| Type | Format | How to obtain |
|------|--------|---------------|
| Developer key | `aig_sk_<48 hex chars>` | Dashboard → Users |
| Agent key | `aig_agt_<48 hex chars>` | Dashboard → Agents |
| Session JWT | `<header>.<payload>.<sig>` | `POST /auth/login` |

```
Authorization: Bearer <token>
```

Token type is detected automatically:
- Starts with `aig_agt_` → agent key
- Contains dots → JWT
- Otherwise → developer key

---

## Endpoints

### `GET /health`
Health check. No auth required.

```json
{ "status": "ok", "ts": "2026-08-11T10:00:00.000Z" }
```

---

### `POST /auth/login`
Authenticate with email and password. Returns a JWT valid for 24 hours.

**Request**
```json
{ "email": "dev@acme.com", "password": "dev123" }
```

**Response 200**
```json
{
  "token": "eyJhbGc...",
  "user":   { "id": "...", "email": "dev@acme.com", "name": "Dev User" },
  "team":   { "id": "...", "name": "Engineering" },
  "policy": { "allowed_models": ["gpt-4o-mini", "claude-haiku-4-5-20251001"] },
  "models": [{ "provider": "openai", "model_id": "gpt-4o-mini", ... }]
}
```

**Errors** — `400` missing fields · `401` invalid credentials

---

### `GET /me`
Returns the authenticated user or agent's info and allowed models.

---

### `POST /proxy/openai/*`
Proxies any OpenAI API endpoint.

```
POST /proxy/openai/v1/chat/completions
POST /proxy/openai/v1/embeddings
```

Request body is identical to the OpenAI API. Response is identical plus gateway headers:

```
X-Gateway-Team:    Engineering
X-Gateway-Policy:  Engineering Policy
X-Gateway-Model:   gpt-4o-mini
X-Gateway-Latency: 342
```

---

### `POST /proxy/anthropic/*`
Proxies any Anthropic API endpoint.

```
POST /proxy/anthropic/v1/messages
```

---

### `POST /proxy/google-gemini/*`
Proxies Google Gemini via its OpenAI-compatible endpoint.

```
POST /proxy/google-gemini/v1/chat/completions
```

Current available models: `gemini-3.6-flash`, `gemini-3.5-flash`, `gemini-3.5-flash-lite`

---

### `POST /proxy/auto/*`
**For agents only.** Routes to the correct provider based on the agent's configured model. The agent does not need to specify `model` in the request body.

```
POST /proxy/auto/v1/chat/completions
POST /proxy/auto/v1/messages
```

If the agent has no model configured:
```json
{
  "error": "no_model_configured",
  "message": "This agent has no default model configured. Set one in the Stratum dashboard."
}
```

---

### `GET /metrics`
Prometheus-format metrics. No auth required (designed for scraping).

```
# HELP stratum_requests_total Total requests processed (last 24h)
stratum_requests_total{team="Engineering",provider="openai",model="gpt-4o-mini",status="200"} 42

# HELP stratum_request_duration_ms Latency percentiles
stratum_request_duration_ms{team="Engineering",quantile="0.95"} 1240

# HELP stratum_token_quota_ratio Current month token usage (0-1)
stratum_token_quota_ratio{team="Marketing"} 0.7320

# ... and more
```

Full list: `stratum_requests_total`, `stratum_tokens_total`, `stratum_cost_usd_total`, `stratum_request_duration_ms`, `stratum_auth_duration_ms`, `stratum_policy_check_duration_ms`, `stratum_provider_duration_ms`, `stratum_token_quota_ratio`, `stratum_budget_quota_ratio`, `stratum_error_rate_pct`

---

## Policy errors

```json
// 403 — model not in team's whitelist
{ "error": "policy_violation", "message": "Model \"gpt-4o\" is not allowed for team \"Marketing\"" }

// 429 — monthly token quota exhausted
{ "error": "quota_exceeded", "message": "Team \"Marketing\" has reached its monthly token quota" }

// 429 — monthly budget exhausted
{ "error": "budget_exceeded", "message": "Team \"Marketing\" has reached its monthly budget" }
```

---

## SDK examples

### Developer — OpenAI SDK (Python)
```python
from openai import OpenAI

client = OpenAI(
    api_key="aig_sk_eng_test1234567890",
    base_url="http://localhost:8080/proxy/openai/v1"
)
response = client.chat.completions.create(
    model="gpt-4o-mini",
    messages=[{"role": "user", "content": "Hello"}]
)
```

### Developer — Anthropic SDK (Python)
```python
import anthropic

client = anthropic.Anthropic(
    api_key="aig_sk_eng_test1234567890",
    base_url="http://localhost:8080/proxy/anthropic"
)
message = client.messages.create(
    model="claude-haiku-4-5-20251001",
    max_tokens=1024,
    messages=[{"role": "user", "content": "Hello"}]
)
```

### Agent — model-agnostic via `/proxy/auto/`
```python
from openai import OpenAI

client = OpenAI(
    api_key="aig_agt_xxxxxxxxxxxx",
    base_url="http://localhost:8080/proxy/auto/v1"
)
# No model needed — Stratum injects it from the agent's dashboard config
response = client.chat.completions.create(
    model="any",
    messages=[{"role": "user", "content": prompt}]
)
```

---

## Error reference

| Status | Code | Description |
|--------|------|-------------|
| 400 | `invalid_provider` | Provider not found or inactive |
| 400 | `no_model_configured` | Agent has no default model set |
| 401 | `unauthorized` | Missing or invalid token |
| 401 | `token_expired` | JWT expired — log in again |
| 403 | `forbidden` | Account is inactive |
| 403 | `policy_violation` | Model not allowed by team policy |
| 429 | `quota_exceeded` | Monthly token quota exhausted |
| 429 | `budget_exceeded` | Monthly budget exhausted |
| 502 | `provider_error` | Could not reach the AI provider |
| 500 | `internal` | Unexpected server error |
