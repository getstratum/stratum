# Changelog

All notable changes to Stratum are documented here.
Format based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

---

## [0.0.2-beta] — 2026-08-11

### Product
- Renamed from **Proxima** to **Stratum** across all code, UI, docs, and metrics

### Added — Dashboard authentication
- Login page at `/login` with email + password
- Next.js middleware protecting all dashboard routes
- Engineering team → full dashboard access; other teams → redirected to Playground
- Signed session cookie (jose HS256, 24h, httpOnly)
- Logout button in sidebar
- `SESSION_SECRET` environment variable for session signing
- `GATEWAY_INTERNAL_URL` for server-side gateway calls (avoids routing through public IP)
- `SECURE_COOKIES` env var (set to `true` only when HTTPS is configured)

### Added — Dashboard UI
- Light mode with violet accent (`#7c3aed`) replacing previous dark theme
- Overview tabs: **General / By provider / By model**
- Date filter with quick selectors (this month, last month, last 3 months, this year) and custom range picker
- Analytics charts: cost by provider (bar + donut), cost by model (horizontal bar)
- Detail tables with CSV export for both provider and model breakdowns
- CSV export for request logs (with active filters applied)
- Filter bar in `/logs`: team, provider, model search, status, row limit

### Added — Playground
- **Persistent chat history** — saved to localStorage, scoped to current user's email (secure: different users see their own history)
- **File attachments** — PDF, images (JPG, PNG, WebP, GIF), text files (.txt, .md, .csv, .json) with drag & drop
- **Context compression** — local LLM (Ollama `llama3.2:1b`) summarizes older messages; rolling summary pattern (Ollama only called when needed, not on every message)
- **Live compression panel** — shows when Compress toggle is ON: messages in context, countdown to next compression, tokens saved, % reduction bar
- **Admin button** — Engineering team users see an "Admin" link back to the dashboard
- Change password modal (⚙ button in header)

### Added — Provider management
- `/providers` page: view all providers, enable/disable, add custom providers
- `providers` DB table: slug, display name, base URL, API type, API key env var
- Pre-seeded providers: OpenAI, Anthropic (active); Azure OpenAI, Google Gemini, AWS Bedrock, Groq, Ollama (inactive)
- Dynamic provider loading in proxy (60s cache, no restart needed)
- URL path construction fix for providers with versioned base URLs (e.g. Gemini `/v1beta/openai`)

### Added — Google Gemini integration
- Current GA models: `gemini-3.6-flash`, `gemini-3.5-flash`, `gemini-3.5-flash-lite`
- Models 1.5 and 2.0 removed (shut down June 2026, return 404)

### Added — Bonsai local model
- Bonsai 8B (PrismML ternary-quantized, ~1 GB) via Ollama as an on-premise provider
- Load from GGUF file: instructions in README
- Zero cost per token (local inference)

### Added — Alerts
- Alert management at `/alerts`
- Email alerts via SMTP (nodemailer)
- Slack alerts via incoming webhooks
- Configurable threshold (50 / 70 / 80 / 90 / 100%)
- Alert types: monthly budget, monthly token quota
- Deduplication: max one alert per day per alert record
- "Reset" button to re-enable a fired alert

### Added — Observability
- Per-stage timing on every request: `auth_ms`, `policy_ms`, `provider_ms`
- `trace_id` UUID on each request
- Expandable trace rows in request log viewer (click any row)
- Prometheus `/metrics` endpoint on the gateway (no auth required for scraping)
- Metrics: requests total, tokens total, cost total, latency p50/p95/p99, auth/policy/provider stage timing, quota ratio, error rate

### Added — Agent management
- `/agents` page with create, edit, deactivate, rotate key
- `aig_agt_` key prefix distinct from `aig_sk_` developer keys
- Model injection: admin configures model in dashboard, proxy overrides `body.model`
- `/proxy/auto/` endpoint: agents call without specifying provider — routed from agent config
- Model selector in agent form filtered by the selected team's allowed models
- `agent_id` in `request_logs`; "Source" column in log viewer shows `agent:Name` or `user`
- Per-agent metrics (requests, tokens, cost) on the agents page

### Fixed
- Token counting now works for all OpenAI-compatible providers (Gemini, Groq, Ollama, Bonsai) — was previously only counting for `openai` and `anthropic` by exact name
- DB migrations 004 and 005 failed with "cannot add column to a partition" — removed explicit partition ALTER statements (PostgreSQL propagates from parent automatically)
- `NEXT_PUBLIC_GATEWAY_URL` now passed as build arg in Dockerfile — was being baked as `localhost:8080` regardless of environment
- Session cookie `secure` flag respects `SECURE_COOKIES` env var instead of `NODE_ENV` — cookies now work over plain HTTP (important for non-HTTPS deployments)
- localStorage history was shared across users on the same browser — now scoped to `email` in the key
- Context compression was re-compressing on every message after threshold was first crossed — `RECOMPRESS_AFTER` raised to 10 (requires 3 exchanges after keeping 4 recent messages)

### Changed
- `request_logs` insert now includes `auth_ms`, `policy_ms`, `provider_ms`, `agent_id`, `trace_id`
- Proxy URL construction: strips version prefix from path when base URL already contains versioned segment
- Docker Compose: added Ollama service with `OLLAMA_KEEP_ALIVE=-1` (model stays in memory)
- `migrate.js` moved to `proxy/src/migrate.js` (accessible inside proxy container)

### Infrastructure
- Full GCP deployment guide (e2-standard-4, Ubuntu 22.04, Docker Compose)
- Auto-migration script: `docker exec ... node /app/src/migrate.js`

---

## [0.1.0] — 2026-08-04

### Initial MVP

- API proxy for OpenAI and Anthropic with full streaming support
- SSE token counting (real counts, not zero)
- Policy enforcement via Redis: model whitelist, token quota, budget quota
- SHA-256 API key authentication (`aig_sk_` prefix)
- Async request logging to PostgreSQL (metadata only)
- Dashboard: overview, teams, users, policies, request log
- Partitioned `request_logs` table (by month)
- `organizations → teams → users → policies` data model
- AI model catalog with per-1K-token pricing
