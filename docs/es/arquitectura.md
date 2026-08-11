# Arquitectura

> 📖 [Read in English](../en/architecture.md)

## Visión general

Stratum usa una **arquitectura split-plane**: el plano de control (dashboard + gestión de políticas) corre en tu cloud, mientras el plano de datos (gateway proxy) corre dentro de la red del cliente. El contenido de los prompts fluye directamente del gateway al proveedor de IA — nunca toca el plano de control.

```
┌──────────────────────────────────────────────────────┐
│                  Plano de Control                     │
│  Dashboard (Next.js) · Políticas · Analytics         │
└─────────────────────┬────────────────────────────────┘
                      │ Solo metadata (sin contenido de prompts)
┌─────────────────────▼────────────────────────────────┐
│                  Plano de Datos                       │  ← Red del cliente
│  AI Gateway (Fastify)                                │
│  Auth → Política → [Inyección de modelo] → Proxy     │
│                                                      │
│  Redis (quotas) · PostgreSQL (logs) · Ollama (local) │
└──────────────────────────────────────────────────────┘
          │
   ┌──────┴───────┐
   ▼              ▼
OpenAI API   Anthropic API   Gemini API   …
```

---

## Pipeline de cada request

```
1. Auth         (~5-15ms)   API key / agent key / JWT → usuario + equipo + política
2. Política      (<5ms)     Redis: modelo permitido? quota ok? budget ok?
3. Inyección     (<1ms)     Para agentes: sobreescribir body.model con modelo configurado
4. Proveedor     (red)      Forward a OpenAI / Anthropic / Gemini / Ollama
5. Log async     (~50ms)    INSERT request_logs + INCR Redis (no bloqueante)
```

---

## Los tres tipos de autenticación

| Token | Formato | Lookup | Caso de uso |
|-------|--------|--------|-------------|
| Developer key | `aig_sk_...` | SHA-256 → tabla `users` | Developers, CI/CD |
| Agent key | `aig_agt_...` | SHA-256 → tabla `agents` | Procesos automatizados |
| Session JWT | `xxx.yyy.zzz` | jose HMAC-HS256 | Playground, dashboard |

Los tres resuelven al mismo pipeline: usuario → equipo → política.

---

## Acceso al dashboard

El middleware de Next.js protege todas las rutas del dashboard:

```
Request a /              → middleware verifica cookie stratum_session
  └── Sin cookie         → redirect a /login
  └── Engineering        → acceso al dashboard
  └── Otro equipo        → redirect a /prompt

/prompt                  → siempre público
/login                   → siempre público
/metrics                 → siempre público (para Prometheus)
```

---

## Inyección de modelo para agentes

Cuando llega un request con key `aig_agt_`:

1. Auth resuelve el agente y carga `default_model` + `default_provider` desde la DB
2. El proxy sobreescribe `body.model` con `agent.default_model`
3. Para `/proxy/auto/`, el proxy también selecciona el proveedor correcto

Los agentes no necesitan conocer el modelo ni el proveedor. El admin lo cambia en el dashboard — sin tocar el código del agente, sin redeployar.

---

## Compresión de contexto

Cuando está habilitada en el Playground, un LLM local (Ollama) resume los mensajes viejos:

```
Primeros 6 mensajes → se envían al proveedor normalmente

Mensaje 7+ → Stratum comprime:
  toCompress = mensajes[0 .. n-4]   (mensajes viejos)
  toKeep     = mensajes[n-4 .. n]   (últimos 4, siempre frescos)
  
  llama Ollama llama3.2:1b → resumen (~100-200 tokens)
  
  envía al proveedor = [resumenMsg, ackMsg, ...toKeep, nuevoMsg]
```

**Resumen rolling**: Ollama se llama solo en la primera compresión (≥6 mensajes) y en la re-compresión (≥10 mensajes recientes). Entre compresiones se reutiliza el resumen existente — cero llamadas a Ollama, cero latencia adicional.

---

## Schema de base de datos

```
Organization
  └── Team (tiene Policy)
        ├── User (api_key_hash | password_hash | ambos)
        └── Agent (api_key_hash, default_model, default_provider)

Policy
  ├── allowed_models: TEXT[]
  ├── monthly_token_quota: BIGINT
  └── monthly_budget_usd: DECIMAL

RequestLog (particionado por mes)
  ├── user_id    (null para requests de agentes)
  ├── agent_id   (null para requests humanos)
  ├── provider, model_id
  ├── tokens_input, tokens_output, cost_usd
  ├── auth_ms, policy_ms, provider_ms   (timing por etapa)
  ├── trace_id, status_code, latency_ms
  └── created_at

Provider
  ├── slug, display_name, base_url
  ├── api_type, api_key_env
  └── is_active, notes
```

Todas las migraciones son idempotentes. Correr con:

```bash
docker exec -it $(docker compose ps -q proxy) node /app/src/migrate.js
```
