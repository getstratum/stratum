# Stratum

**An open-source AI gateway that enforces your organization's AI policies inside your own network.**

Stratum sits between your applications and LLM providers (OpenAI, Anthropic,
Gemini, Groq, Azure OpenAI, Ollama and other OpenAI-compatible APIs). It
authenticates every developer and agent, applies per-team policies, quotas and
PII/secret controls, and forwards the request with your organization's own
provider credentials.

It is built as two planes:

- **Gateway (data plane)**, a single Go binary that runs in your network. Prompts
  and responses never leave it except toward the provider you chose.
- **Control plane**, where you manage teams, keys, policies and providers. It can
  run anywhere; the gateway only pulls configuration from it.

The gateway is designed to keep serving when everything except the LLM provider
is down: it holds its configuration as an in-memory snapshot, persists it
encrypted to disk, and never calls the control plane, a database or Redis on the
request path. See [docs/architecture](docs/architecture/overview.md).

> **Status: pre-release (0.x).** APIs and configuration may still change.
> See the [release checklist](docs/release-checklist.md).

## Quick start: standalone gateway

No control plane needed: describe teams, keys and providers in a file.

```sh
# 1. Hash a developer key (the raw key is never stored)
echo -n "my-team-key" | docker run --rm -i ghcr.io/getstratum/stratum-gateway hash-key

# 2. Put the hash in a copy of deploy/standalone/stratum.example.json
cp deploy/standalone/stratum.example.json stratum.json

# 3. Run the gateway
docker run --rm -p 20128:20128 \
  -v "$PWD/stratum.json:/etc/stratum/stratum.json:ro" \
  -e STRATUM_CONFIG_FILE=/etc/stratum/stratum.json \
  -e OPENAI_API_KEY -e ANTHROPIC_API_KEY \
  ghcr.io/getstratum/stratum-gateway

# 4. Point any OpenAI SDK at it
curl http://localhost:20128/v1/chat/completions \
  -H "Authorization: Bearer my-team-key" \
  -d '{"model": "openai/gpt-4o-mini", "messages": [{"role": "user", "content": "Hello"}]}'
```

Send `SIGHUP` to reload the file. A broken file is rejected and the previous
configuration keeps serving.

## Quick start: with the control plane

```sh
cp deploy/compose/.env.example deploy/compose/.env   # fill in the secrets
make up                                              # PostgreSQL + control plane on :3000
```

Then follow the comments in `deploy/compose/docker-compose.yml` to register a
gateway and start it.

## Quick start: Kubernetes (highly available)

```sh
helm install stratum oci://ghcr.io/getstratum/charts/stratum-gateway -n stratum \
  --set controlPlane.url=https://stratum-cp.example.com \
  --set existingSecret=stratum-gateway
```

Three replicas across zones, a disruption budget, zero-capacity-loss rollouts
and graceful drain of streams by default. See [deploy/helm](deploy/helm/README.md).

## Calling the gateway

| Route | Use |
|---|---|
| `POST /v1/...` | OpenAI-compatible. The provider comes from `"model": "provider/model"`, or from the team policy when it allows a single provider. |
| `POST /proxy/{provider}/...` | Explicit provider, e.g. `/proxy/anthropic/v1/messages` for the Anthropic SDK. |
| `GET /livez`, `GET /readyz` | Probes. Readiness depends only on having a configuration and not draining. |
| `GET /metrics` (admin port `:9090`) | Prometheus metrics. Keep the admin port private. |

Developers authenticate with `Authorization: Bearer <key>` or `x-api-key: <key>`.

## Gateway configuration

| Variable | Default | Purpose |
|---|---|---|
| `STRATUM_CP_URL` | | Control plane URL (control plane mode). Must be https unless `STRATUM_CP_ALLOW_HTTP=true`. |
| `STRATUM_SYNC_TOKEN`, `STRATUM_INSTANCE_ID` | | Issued when you register the gateway in the control plane. |
| `STRATUM_CONFIG_FILE` | | Standalone mode: path to the configuration file. |
| `STRATUM_SNAPSHOT_KEY` | | 64 hex chars. Enables the encrypted snapshot on disk, so the gateway can start while the control plane is unreachable. |
| `STRATUM_SNAPSHOT_PATH` | `/var/lib/stratum/snapshot.bin` | Where the snapshot is stored. |
| `STRATUM_LISTEN_ADDR` / `STRATUM_ADMIN_ADDR` | `:20128` / `:9090` | Public and admin listeners. |
| `STRATUM_SYNC_INTERVAL` / `STRATUM_FULL_RESYNC_INTERVAL` | `30s` / `10m` | Delta sync cadence and full resync cadence. |
| `STRATUM_MAX_INFLIGHT` | `1024` | Concurrent requests before shedding load with 503 + `Retry-After`. |
| `STRATUM_UPSTREAM_HEADER_TIMEOUT` | `120s` | Max wait for the provider's first response byte. |
| `STRATUM_STREAM_IDLE_TIMEOUT` | `60s` | Max silence between streamed chunks. |
| `STRATUM_DRAIN_DELAY` / `STRATUM_SHUTDOWN_TIMEOUT` | `5s` / `10m` | Graceful shutdown: readiness fails first, then in-flight streams get up to the timeout to finish. |
| `STRATUM_PII_ENABLED` | `true` | Global switch for PII/DLP scanning (actions are set per policy). |
| `STRATUM_CORS_ALLOWED_ORIGINS` | | Comma-separated origins allowed to call the gateway from a browser. |

## Repository layout

```
gateway/        Go data plane (standard library only)
control-plane/  Next.js control plane and SQL migrations
api/            sync contract between the planes (JSON Schema + examples)
deploy/         Helm chart, Docker Compose and standalone examples
docs/           architecture and decision records (docs/adr)
```

## Contributing and security

See [CONTRIBUTING.md](CONTRIBUTING.md). Report vulnerabilities privately as
described in [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE) © 2026 Matech SAS
