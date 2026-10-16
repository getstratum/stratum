# Console functional test

Drives the console in a real browser (Playwright, Chromium) the way an
administrator would, and checks the effect on a gateway synced with it:

| Step | What it checks |
|---|---|
| Sign-in | A wrong password is refused with a message that does not say why; the owner sees every section. |
| Security | The session cookie is `HttpOnly` (and `Secure` over https); a request from another site gets 403. |
| Providers | A custom endpoint can be added, disabled and revoked, and its credential is never returned. A preset refuses a plain `http://` address. |
| Gateways | Registering shows the sync token once; rotating gives a new one; disabling works. At least one gateway of the installation is online. |
| Agents | A new agent key is refused before the sync and accepted after it through the gateway; once revoked it is refused again. |
| People and roles | The owner creates an auditor, who can read but not change anything: the buttons that would change something are hidden, and the API answers 403. |
| My account | Changing the password works and the old one stops working. |
| Deactivation | Deactivating a person ends their session at once. |
| Audit log | Everything above is recorded, refusals included; the filter shows only refusals. |
| Sign-out | The session ends on the server too, not just in the browser. |

Everything the test creates carries `e2e-<run>` in its name and is revoked,
disabled or deactivated at the end, even when a step fails. It also signs in
once with a wrong password as the owner (one of the ten attempts allowed in
15 minutes).

## Against a running installation

```sh
cd control-plane/e2e
npm ci
npx playwright install --with-deps chromium   # once

STRATUM_E2E_CONSOLE_URL=https://console.example.com \
STRATUM_E2E_GATEWAY_URL=https://gateway.example.com \
STRATUM_E2E_EMAIL=owner@example.com \
STRATUM_E2E_PASSWORD='...' \
npx playwright test
```

| Variable | Default | |
|---|---|---|
| `STRATUM_E2E_CONSOLE_URL` | required | The console. |
| `STRATUM_E2E_EMAIL`, `STRATUM_E2E_PASSWORD` | required | An Owner of the organization. |
| `STRATUM_E2E_GATEWAY_URL` | none | A gateway synced with that console. Without it the gateway steps are skipped. |
| `STRATUM_E2E_TEAM` | `Engineering` | Team for the test agent; its policy must allow the model below. |
| `STRATUM_E2E_MODEL` | `ollama/mock-1` | Model the agent calls through the gateway. |
| `STRATUM_E2E_SYNC_TIMEOUT_S` | `60` | How long a key change may take to reach the gateway (the sync interval is 30 s, ±20%). |
| `STRATUM_E2E_INSECURE_TLS` | `false` | `true` accepts a self-signed console certificate. |
| `STRATUM_E2E_CHROMIUM` | Playwright's | Path to another Chromium build. |

The HTML report is written to `report/` (`npx playwright show-report report`);
screenshots and traces of failed steps to `results/`.

On the GCP reference deployment: `make test-console` in `deploy/gcp`.

## Against a stack started here

`run-local.sh` starts the console, a gateway and the mock LLM against a
PostgreSQL database with every migration applied, and runs the test. CI runs
it on every pull request. It changes the database (owner password, policies,
providers), so use a throwaway one:

```sh
DATABASE_URL=postgres://stratum:stratum@localhost:5432/stratum control-plane/e2e/run-local.sh
```

It needs Node.js, Go, `psql`, `jq` and `openssl`, and ports 3125, 8080,
20128 and 20129.
