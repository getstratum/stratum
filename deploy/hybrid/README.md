# Hybrid test: control plane in GCP, gateway on your machine

The smallest setup of the hybrid topology (ADR-0008): the control plane on
one VM in Google Cloud, a gateway on your laptop or in your datacenter, and an
agent that calls Claude through that gateway with a Stratum key. Your Claude
API key is stored once in the control plane (encrypted) and reaches the
gateway through the sync channel; the agent never sees it.

```
 your machine                                   Google Cloud (one VM)
 ┌──────────────────────────────┐   HTTPS      ┌──────────────────────────────┐
 │ agent.py ─► gateway :20128 ──┼── sync ─────►│ Caddy ─► control plane       │
 │                 │            │              │            PostgreSQL        │
 │       (Valkey, optional)     │              └──────────────────────────────┘
 └─────────────────┼────────────┘
                   └──────────────► api.anthropic.com (with the org's key)
```

Cost: one e2-medium VM, about US$0.04 per hour. `./down.sh` deletes it.

## 1. Control plane (Cloud Shell)

```sh
cd deploy/hybrid
# On your laptop: curl -s ifconfig.me  -> the only IP allowed to open the console
PROJECT_ID=<project> CONSOLE_CIDR=<your-ip>/32 ./up.sh
```

It creates a network, two firewall rules (HTTPS from anywhere, SSH only
through Identity-Aware Proxy) and the VM, then builds and starts PostgreSQL,
the migrations, the control plane and Caddy, which gets a certificate for
`<ip>.sslip.io`. The console answers only to `CONSOLE_CIDR`; the sync
endpoint answers to any gateway with a valid sync token.

Then register your gateway and your Claude key:

```sh
gcloud compute ssh stratum-cp --zone us-central1-a --tunnel-through-iap --project <project> \
  --ssh-flag=-t --command 'sudo bash /opt/stratum/bootstrap.sh'
```

`bootstrap.sh` replaces the demo keys published in the seed data, creates a
console key and an agent key, lets the Engineering team use any model,
registers a gateway instance and asks for your Claude API key (not echoed).
It prints the commands for the next step. They are also saved on the VM in
`/opt/stratum/credentials.txt` (root only).

## 2. Gateway and agent (Windows, Docker Desktop)

From the repository folder:

```powershell
powershell -ExecutionPolicy Bypass -File deploy\hybrid\pc\run-gateway.ps1 `
  -CpUrl https://<ip>.sslip.io -InstanceId dp_... -SyncToken dp_sync_...
# add -WithValkey to also run a local Valkey (shared snapshot, ADR-0008)

pip install anthropic
$env:STRATUM_KEY = "aig_sk_..."   # the agent key from bootstrap.sh
python deploy\hybrid\pc\agent.py "¿Qué hora es y cuánto es 17 * 23?"
```

The agent uses the official Anthropic SDK with only two changes: the base URL
is the gateway and the API key is a Stratum key. It has two tools (current
time, arithmetic) and loops until Claude answers without calling one.
`MODEL` overrides the default `claude-haiku-4-5`.

## 3. Things to try

| Try | Expect |
|---|---|
| Revoke the agent's key in the console (Users) | Within one sync (≤ 30 s) the agent gets 401 |
| On the VM: `sudo /opt/stratum/compose.sh stop control-plane` | The agent keeps working: the gateway serves its last configuration |
| With the control plane stopped: `docker restart stratum-gateway` | It starts from its snapshot on disk and keeps serving |
| Same, after `docker volume rm` of its data, with `-WithValkey` | It starts from the copy in Valkey (ADR-0008) |
| `docker logs stratum-gateway`, `http://127.0.0.1:9090/metrics` | Sync status, snapshot age, request counts |

## Known gaps (this is a test, not a product setup)

- The console's **Providers** page edits a legacy table that gateways do not
  read; provider credentials for gateways are set through
  `POST /api/internal/providers`, as `bootstrap.sh` does.
- Gateway instances are registered through the API; there is no page yet.
- Usage is not reported from the gateway to the control plane yet, so the
  console does not show the agent's requests.
- The gateway proxies `POST` requests only (no model listing).
- One VM, no backups: delete it when you are done (`./down.sh`).
