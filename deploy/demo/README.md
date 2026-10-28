# Stratum demo

Stratum in one command, to look around: the console, a gateway, a mock LLM
instead of real providers, and a demo organization with four weeks of usage.
No provider keys, nothing is paid.

> **Demo only.** Passwords, keys and secrets here are fixed and public. The
> ports listen on 127.0.0.1 only; do not change that, and do not use this
> for real work. For development use [deploy/compose](../compose), for
> production the [Helm charts](../helm).

## Run it

Docker with Compose v2 (Docker Desktop, or Docker Engine on Linux, or
Google Cloud Shell). From the repository's root:

```sh
make demo        # builds the images the first time (a few minutes)
make demo-down   # stops everything and deletes its data
```

Without `make` (Windows PowerShell, for example), the same steps:

```sh
docker compose -f deploy/demo/docker-compose.yml up -d --build --wait control-plane mock-llm
docker compose -f deploy/demo/docker-compose.yml up --build --exit-code-from setup setup
docker compose -f deploy/demo/docker-compose.yml up -d --build gateway
docker compose -f deploy/demo/docker-compose.yml up --exit-code-from traffic traffic
```

## Look around

Open <http://localhost:3000>:

| Account | Password | |
|---|---|---|
| `auditor@acme.com` | `stratum-demo-auditor` | Reads everything, changes nothing. The quickest look. |
| `owner@acme.com` | `stratum-demo-owner` | Changes anything. Sets up a second factor at the first sign-in (any authenticator app). |

Worth a look:

- **Consumo:** cost, tokens, latency and estimated emissions by team, agent,
  person, model, provider or label. Try *Últimos 30 días* and the *CO2e*
  measure.
- **Modelos:** the catalog with prices and emissions per 1,000 tokens.
- **Requests:** each request, including one a policy refused and one whose
  email address was redacted before it reached the provider.
- **Políticas:** what each team may use, its quota and budget, and
  Engineering's instructions for people.

The gateway answers on <http://localhost:20128> with the OpenAI API. `make
demo` prints a developer key; with it:

```sh
curl http://localhost:20128/v1/chat/completions \
  -H "Authorization: Bearer <the key it printed>" \
  -H "content-type: application/json" \
  -d '{"model":"openai/gpt-4o-mini","messages":[{"role":"user","content":"Hola"}]}'
```

In Windows PowerShell, `curl` is another command; use `curl.exe` on one
line, with the JSON's quotes escaped:

```powershell
curl.exe http://localhost:20128/v1/chat/completions -H "Authorization: Bearer <the key it printed>" -H "content-type: application/json" -d '{\"model\":\"openai/gpt-4o-mini\",\"messages\":[{\"role\":\"user\",\"content\":\"Hola\"}]}'
```

Each request shows up in Consumo a few seconds later. The mock always
answers the same sentence and reports tokens from the request (up to 600
of output), so costs and emissions look like real traffic. `openai/gpt-4o` with
the Marketing key is refused: its policy does not allow it.

## What is in it

| Piece | |
|---|---|
| Acme Corp (Demo) | Engineering, Marketing and Soporte, each with its policy; four people with developer keys; two agents |
| Providers | OpenAI and Mistral, both answered by the mock LLM (`deploy/gcp/mock-llm`) |
| History | About 2,400 requests over 28 days, reported the way a gateway reports usage, across OpenAI, Anthropic, Gemini, Mistral and a local Ollama model (which has no price and no emissions estimate, and the console says so) |
| Today | About 40 requests through the gateway (`traffic.mjs`) |

`setup.mjs` and `traffic.mjs` hold the details. Running `make demo` again
keeps the data; `make demo-down` deletes it.
