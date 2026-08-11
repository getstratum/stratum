# Referencia de API

> 📖 [Read in English](../en/api-reference.md)

El gateway de Stratum corre en el puerto `8080`. Todos los requests requieren token `Bearer` excepto `/health`, `/auth/login` y `/metrics`.

---

## Autenticación

Se aceptan tres tipos de token:

| Tipo | Formato | Cómo obtener |
|------|---------|--------------|
| Developer key | `aig_sk_<48 hex>` | Dashboard → Usuarios |
| Agent key | `aig_agt_<48 hex>` | Dashboard → Agentes |
| Session JWT | `<header>.<payload>.<sig>` | `POST /auth/login` |

```
Authorization: Bearer <token>
```

---

## Endpoints principales

### `GET /health`
Health check. Sin auth.
```json
{ "status": "ok", "ts": "2026-08-11T10:00:00.000Z" }
```

### `POST /auth/login`
Autenticación con email y contraseña.

```json
{ "email": "dev@acme.com", "password": "dev123" }
```

### `GET /me`
Info del usuario/agente autenticado y modelos permitidos.

### `POST /proxy/openai/*`
Proxea cualquier endpoint de OpenAI.
```
POST /proxy/openai/v1/chat/completions
```

### `POST /proxy/anthropic/*`
Proxea cualquier endpoint de Anthropic.
```
POST /proxy/anthropic/v1/messages
```

### `POST /proxy/google-gemini/*`
Proxea Google Gemini via endpoint compatible con OpenAI.
```
POST /proxy/google-gemini/v1/chat/completions
```
Modelos disponibles: `gemini-3.6-flash`, `gemini-3.5-flash`, `gemini-3.5-flash-lite`

### `POST /proxy/auto/*`
**Solo para agentes.** Routea automáticamente al proveedor configurado del agente. No requiere `model` en el body.

### `GET /metrics`
Métricas en formato Prometheus. Sin auth requerida.

---

## Errores de política

```json
{ "error": "policy_violation", "message": "Model \"gpt-4o\" is not allowed for team \"Marketing\"" }
{ "error": "quota_exceeded",   "message": "Team \"Marketing\" has reached its monthly token quota" }
{ "error": "budget_exceeded",  "message": "Team \"Marketing\" has reached its monthly budget" }
```

---

## Ejemplos con SDKs

### Developer — Python (OpenAI SDK)
```python
from openai import OpenAI

client = OpenAI(
    api_key="aig_sk_eng_test1234567890",
    base_url="http://localhost:8080/proxy/openai/v1"
)
response = client.chat.completions.create(
    model="gpt-4o-mini",
    messages=[{"role": "user", "content": "Hola"}]
)
```

### Agente — sin modelo ni proveedor hardcodeado
```python
from openai import OpenAI

client = OpenAI(
    api_key="aig_agt_xxxxxxxxxxxx",
    base_url="http://localhost:8080/proxy/auto/v1"
)
# Sin campo "model" — Stratum lo inyecta desde la config del dashboard
response = client.chat.completions.create(
    model="any",
    messages=[{"role": "user", "content": prompt}]
)
```

---

## Referencia de errores

| Status | Código | Descripción |
|--------|--------|-------------|
| 400 | `invalid_provider` | Provider no encontrado o inactivo |
| 400 | `no_model_configured` | Agente sin modelo configurado |
| 401 | `unauthorized` | Token faltante o inválido |
| 401 | `token_expired` | JWT expirado |
| 403 | `forbidden` | Cuenta inactiva |
| 403 | `policy_violation` | Modelo no permitido por la política del equipo |
| 429 | `quota_exceeded` | Quota mensual de tokens agotada |
| 429 | `budget_exceeded` | Budget mensual agotado |
| 502 | `provider_error` | No se pudo alcanzar el proveedor de IA |
| 500 | `internal` | Error interno del servidor |
