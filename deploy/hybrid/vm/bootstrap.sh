#!/usr/bin/env bash
# Runs on the VM as root, with a terminal (it asks for your Claude API key).
#
#   1. Replaces the demo keys published in the repository's seed data.
#   2. Creates a key for the console (dev@acme.com) and one for your agent.
#   3. Lets the Engineering team use any Claude model.
#   4. Registers a gateway instance (prints its sync token once).
#   5. Stores your Claude API key as the Anthropic provider (encrypted).
#
# Prints what the gateway on your machine needs. Running it again rotates
# both keys and registers a new instance.
set -euo pipefail

BASE=/opt/stratum
# shellcheck source=/dev/null
source "$BASE/host.env"
CP=http://127.0.0.1:3000
ENG_TEAM=20000000-0000-0000-0000-000000000001
ENG_POLICY=10000000-0000-0000-0000-000000000001
ORG=00000000-0000-0000-0000-000000000001

psql() { "$BASE/compose.sh" exec -T postgres psql -U stratum -d stratum -v ON_ERROR_STOP=1 -qAt; }
hash() { printf '%s' "$1" | sha256sum | cut -d' ' -f1; }
newkey() { echo "aig_sk_$(openssl rand -hex 24)"; }

[[ -t 0 ]] || { echo "run with a terminal: gcloud compute ssh ... --ssh-flag=-t" >&2; exit 1; }

echo "==> Keys"
ADMIN_KEY="$(newkey)"
AGENT_KEY="$(newkey)"
psql <<SQL
-- The seed's keys are published in the repository: replace both.
UPDATE users SET api_key_hash = '$(hash "$ADMIN_KEY")', api_key_prefix = '${ADMIN_KEY:0:14}...'
  WHERE email = 'dev@acme.com';
UPDATE users SET api_key_hash = '$(hash "$(newkey)")', api_key_prefix = NULL
  WHERE email = 'marketing@acme.com';
-- The agent gets its own user, so it can be revoked on its own.
INSERT INTO users (org_id, team_id, email, name, role, api_key_hash, api_key_prefix)
  VALUES ('$ORG', '$ENG_TEAM', 'agente@acme.com', 'Agente (PC)', 'user', '$(hash "$AGENT_KEY")', '${AGENT_KEY:0:14}...')
  ON CONFLICT (email) DO UPDATE SET api_key_hash = EXCLUDED.api_key_hash, api_key_prefix = EXCLUDED.api_key_prefix,
    team_id = EXCLUDED.team_id, is_active = true;
-- Any Claude model, so the test does not depend on a model list.
UPDATE policies SET allow_all_models = true WHERE id = '$ENG_POLICY';
SQL
echo "  console and agent keys replaced; Engineering may use any model"

echo "==> Console session"
COOKIE="$(printf '{"email":"dev@acme.com","password":"%s"}' "$ADMIN_KEY" |
  curl -sS -D - -o /dev/null -H 'content-type: application/json' --data-binary @- "$CP/api/session" |
  tr -d '\r' | sed -n 's/^[Ss]et-[Cc]ookie: \(stratum_session=[^;]*\).*/\1/p')"
[[ -n "$COOKIE" ]] || { echo "could not log in to the control plane" >&2; exit 1; }
api() { curl -sS -f -H "Cookie: $COOKIE" -H 'content-type: application/json' "$@"; }

echo "==> Gateway instance"
REG="$(api -d '{"label":"pc-local"}' "$CP/api/internal/instances")"
INSTANCE_ID="$(printf '%s' "$REG" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')"
SYNC_TOKEN="$(printf '%s' "$REG" | sed -n 's/.*"sync_token":"\([^"]*\)".*/\1/p')"
[[ -n "$INSTANCE_ID" && -n "$SYNC_TOKEN" ]] || { echo "instance registration failed: $REG" >&2; exit 1; }
echo "  registered $INSTANCE_ID"

echo "==> Anthropic provider"
read -rsp "  Claude API key (sk-ant-..., not echoed): " CLAUDE_KEY; echo
[[ "$CLAUDE_KEY" == sk-ant-* ]] || echo "  warning: that does not look like an Anthropic key; storing it anyway"
# The key goes in the request body over the loopback interface and is
# stored encrypted (STRATUM_ENCRYPTION_KEY); it is never written to disk here.
python3 - "$CLAUDE_KEY" <<'PY' | api -o /dev/null --data-binary @- "$CP/api/internal/providers"
import json, sys
print(json.dumps({"provider": "anthropic", "display_name": "Claude", "api_key": sys.argv[1]}))
PY
unset CLAUDE_KEY
echo "  stored"

echo "==> Check: what a gateway with this token receives"
# Kept in memory only: the response carries the provider key in clear.
SYNC_JSON="$(curl -sS -H "Authorization: Bearer $SYNC_TOKEN" "$CP/api/internal/sync?since_version=0&instance_id=$INSTANCE_ID")" \
python3 - <<'PY'
import json, os
d = json.loads(os.environ["SYNC_JSON"])
keys = [k for k in d["api_keys"] if not k["revoked"]]
prov = [p["provider"] for p in d["provider_configs"] if p["enabled"] and not p["revoked"] and p["api_key"]]
print(f"  version {d['current_version']}: {len(keys)} active keys, providers with a key: {prov}")
PY

umask 077
cat >"$BASE/credentials.txt" <<EOF
CP_URL=https://$HOST
INSTANCE_ID=$INSTANCE_ID
SYNC_TOKEN=$SYNC_TOKEN
CONSOLE_LOGIN=dev@acme.com
CONSOLE_KEY=$ADMIN_KEY
AGENT_KEY=$AGENT_KEY
EOF

cat <<EOF

Saved on the VM in $BASE/credentials.txt (root only). Copy these now:

  Console   https://$HOST   login dev@acme.com / $ADMIN_KEY

  On your PC (PowerShell), from the repository folder:
    deploy\\hybrid\\pc\\run-gateway.ps1 -CpUrl https://$HOST -InstanceId $INSTANCE_ID -SyncToken $SYNC_TOKEN
    \$env:STRATUM_KEY = "$AGENT_KEY"
    python deploy\\hybrid\\pc\\agent.py
EOF
