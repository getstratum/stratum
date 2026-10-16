#!/usr/bin/env bash
# Runs the console functional test against a stack started here: the console
# (next start), a gateway synced with it, and the mock LLM. CI runs this; it
# also works on a laptop with Node.js, Go, psql and a PostgreSQL.
#
#   DATABASE_URL=postgres://...  control-plane/e2e/run-local.sh [playwright args]
#
# DATABASE_URL must point to a database with every migration applied (the
# demo seed included). The script changes it: it makes dev@acme.com the
# owner with a random password, lets the Engineering policy use every model,
# registers a gateway and points the ollama provider at the mock. Use a
# throwaway database.
#
# Ports: 3125 (console), 20128/20129 (gateway), 8080 (mock LLM).
# STRATUM_E2E_SKIP_BUILD=1 reuses the console's existing .next build;
# STRATUM_GATEWAY_BIN / STRATUM_MOCK_LLM_BIN reuse built binaries.
set -euo pipefail

: "${DATABASE_URL:?set DATABASE_URL to a migrated database}"
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
DASH="$ROOT/control-plane/dashboard"
WORK="$(mktemp -d)"
CONSOLE=http://localhost:3125
GATEWAY=http://127.0.0.1:20128
PIDS=()

log() { printf '==> %s\n' "$*"; }
# bg LOG CMD...: start CMD in its own process group, so stop() also ends its children.
# Without setsid (macOS) only the command itself is stopped.
bg() {
  local out="$1"; shift
  if command -v setsid >/dev/null; then setsid "$@" >"$out" 2>&1 & else "$@" >"$out" 2>&1 & fi
  PIDS+=("$!")
}
stop() {
  for p in "${PIDS[@]:-}"; do [[ -n "$p" ]] && { kill -- "-$p" 2>/dev/null || kill "$p" 2>/dev/null || true; }; done
  if [[ "${KEEP_LOGS:-}" != 1 ]]; then rm -rf "$WORK"; else echo "logs in $WORK"; fi
}
trap stop EXIT
fail() { echo "error: $*" >&2; for f in "$WORK"/*.log; do echo "--- $f"; tail -20 "$f"; done >&2; exit 1; }
wait_for() { # url want what
  for _ in $(seq 1 60); do
    [[ "$(curl -s -o /dev/null -w '%{http_code}' "$1" || true)" == "$2" ]] && return 0
    sleep 1
  done
  fail "$3 did not answer $2 at $1"
}

log "binaries"
GW_BIN="${STRATUM_GATEWAY_BIN:-}"
if [[ -z "$GW_BIN" ]]; then
  GW_BIN="$WORK/stratum-gateway"
  (cd "$ROOT/gateway" && go build -o "$GW_BIN" ./cmd/stratum-gateway)
fi
MOCK_BIN="${STRATUM_MOCK_LLM_BIN:-}"
if [[ -z "$MOCK_BIN" ]]; then
  MOCK_BIN="$WORK/mock-llm"
  (cd "$ROOT/deploy/gcp/mock-llm" && go build -o "$MOCK_BIN" .)
fi

log "console"
if [[ "${STRATUM_E2E_SKIP_BUILD:-}" != 1 ]]; then
  (cd "$DASH" && NEXT_TELEMETRY_DISABLED=1 npm run build >"$WORK/build.log" 2>&1) || fail "console build failed"
fi
# Gateways sync every 5 s instead of 30, so key changes show up quickly.
bg "$WORK/console.log" env DATABASE_URL="$DATABASE_URL" STRATUM_ENCRYPTION_KEY="$(openssl rand -hex 32)" \
  SECURE_COOKIES=false STRATUM_SYNC_INTERVAL_S=5 NEXT_TELEMETRY_DISABLED=1 "$DASH/node_modules/.bin/next" start "$DASH" -p 3125
wait_for "$CONSOLE/login" 200 "the console"

PASSWORD="e2e-$(openssl rand -hex 12)"
printf '%s' "$PASSWORD" | (cd "$DASH" && DATABASE_URL="$DATABASE_URL" node scripts/stratum-admin.mjs create-owner \
  --email dev@acme.com --org-id 00000000-0000-0000-0000-000000000001 --password-stdin >/dev/null)
psql "$DATABASE_URL" -X -q -v ON_ERROR_STOP=1 \
  -c "UPDATE policies SET allow_all_models = true, allowed_providers = NULL WHERE name = 'Engineering Policy'"

log "gateway registration and provider"
JAR="$WORK/cookies"
cp_api() { # method path [json]
  curl -sS -f -b "$JAR" -c "$JAR" -H 'content-type: application/json' -H "origin: $CONSOLE" \
    -X "$1" "$CONSOLE$2" ${3:+--data-binary "$3"}
}
cp_api POST /api/session "$(jq -n --arg p "$PASSWORD" '{email: "dev@acme.com", password: $p}')" >/dev/null ||
  fail "could not sign in as the owner"
INSTANCE="$(cp_api POST /api/internal/instances '{"name":"e2e-local"}')" || fail "could not register the gateway"
cp_api POST /api/internal/providers '{"provider":"ollama","base_url":"http://127.0.0.1:8080","api_key":"mock"}' >/dev/null ||
  fail "could not add the provider"

log "mock LLM and gateway"
bg "$WORK/mock.log" "$MOCK_BIN"
bg "$WORK/gateway.log" env STRATUM_CP_URL=http://127.0.0.1:3125 STRATUM_CP_ALLOW_HTTP=true \
  STRATUM_INSTANCE_ID="$(jq -r .id <<<"$INSTANCE")" STRATUM_SYNC_TOKEN="$(jq -r .sync_token <<<"$INSTANCE")" \
  STRATUM_SNAPSHOT_KEY="$(openssl rand -hex 32)" STRATUM_SNAPSHOT_PATH="$WORK/snapshot.bin" \
  STRATUM_LISTEN_ADDR=127.0.0.1:20128 STRATUM_ADMIN_ADDR=127.0.0.1:20129 STRATUM_USAGE_INTERVAL=2s \
  "$GW_BIN"
wait_for "$GATEWAY/readyz" 200 "the gateway"

log "functional test"
cd "$HERE"
STRATUM_E2E_CONSOLE_URL="$CONSOLE" STRATUM_E2E_GATEWAY_URL="$GATEWAY" \
  STRATUM_E2E_EMAIL=dev@acme.com STRATUM_E2E_PASSWORD="$PASSWORD" STRATUM_E2E_SYNC_TIMEOUT_S=30 \
  npx playwright test "$@" || fail "functional test failed (report: control-plane/e2e/report/index.html)"
