#!/usr/bin/env bash
# Runs on the VM as root (up.sh calls it). Installs Docker, checks out the
# repository and starts PostgreSQL, the migrations, the control plane and
# Caddy (automatic HTTPS for HOST). Safe to run again: secrets are kept.
#
#   HOST=1-2-3-4.sslip.io CONSOLE_CIDR=203.0.113.10/32 bash setup.sh
set -euo pipefail

HOST="${HOST:?}"
CONSOLE_CIDR="${CONSOLE_CIDR:?}"
REPO="${REPO:-https://github.com/getstratum/stratum.git}"
REF="${REF:-main}"
BASE=/opt/stratum
CADDY_IMAGE="${CADDY_IMAGE:-caddy:2.11.4-alpine}"

say() { printf '  %s\n' "$*"; }

# ── Docker (official apt repository) ───────────────────────────────────────
if ! command -v docker >/dev/null || ! docker compose version >/dev/null 2>&1; then
  say "installing Docker"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq ca-certificates curl git openssl >/dev/null
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
    >/etc/apt/sources.list.d/docker.list
  apt-get update -qq
  apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin >/dev/null
fi

command -v python3 >/dev/null || { apt-get update -qq && apt-get install -y -qq python3 >/dev/null; }

# The Next.js build needs more than the VM's 4 GB at peak.
if ! swapon --show | grep -q /swapfile; then
  say "adding 2 GB of swap for the build"
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
  grep -q /swapfile /etc/fstab || echo '/swapfile none swap sw 0 0' >>/etc/fstab
fi

# ── Source ─────────────────────────────────────────────────────────────────
mkdir -p "$BASE"
chmod 700 "$BASE"
if [[ -d "$BASE/src/.git" ]]; then
  git -C "$BASE/src" fetch -q origin "$REF" && git -C "$BASE/src" checkout -q FETCH_HEAD
else
  git clone -q --branch "$REF" "$REPO" "$BASE/src"
fi
say "source at $(git -C "$BASE/src" rev-parse --short HEAD)"

# ── Secrets (generated once) ───────────────────────────────────────────────
if [[ ! -f "$BASE/.env" ]]; then
  umask 077
  cat >"$BASE/.env" <<EOF
POSTGRES_PASSWORD=$(openssl rand -hex 24)
SESSION_SECRET=$(openssl rand -hex 32)
STRATUM_ENCRYPTION_KEY=$(openssl rand -hex 32)
# The compose file also defines the gateway service, which does not run on
# this VM; these placeholders only satisfy its variable checks.
STRATUM_SYNC_TOKEN=unused
STRATUM_INSTANCE_ID=unused
STRATUM_SNAPSHOT_KEY=unused
EOF
  say "generated secrets in $BASE/.env"
fi

# ── Caddy: HTTPS, console only from CONSOLE_CIDR ───────────────────────────
cat >"$BASE/Caddyfile" <<EOF
$HOST {
	# Gateways sync from wherever they run; the endpoints check the sync token.
	@sync path /api/internal/sync /api/internal/metrics
	handle @sync {
		reverse_proxy control-plane:3000
	}
	@console remote_ip $CONSOLE_CIDR
	handle @console {
		reverse_proxy control-plane:3000
	}
	handle {
		respond "Forbidden" 403
	}
}
EOF

cat >"$BASE/compose.hybrid.yml" <<EOF
services:
  caddy:
    image: $CADDY_IMAGE
    restart: unless-stopped
    ports: ["80:80", "443:443"]
    volumes:
      - $BASE/Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy-data:/data
      - caddy-config:/config
    depends_on: [control-plane]
volumes:
  caddy-data:
  caddy-config:
EOF

cp "$(dirname "$0")/bootstrap.sh" "$BASE/bootstrap.sh"
cat >"$BASE/compose.sh" <<EOF
#!/bin/sh
exec docker compose -p stratum -f $BASE/src/deploy/compose/docker-compose.yml -f $BASE/compose.hybrid.yml --env-file $BASE/.env "\$@"
EOF
chmod 700 "$BASE/compose.sh" "$BASE/bootstrap.sh"
echo "HOST=$HOST" >"$BASE/host.env"

# ── Start ──────────────────────────────────────────────────────────────────
say "building and starting (PostgreSQL, migrations, control plane, Caddy)"
"$BASE/compose.sh" up -d --build postgres migrate control-plane caddy

say "waiting for the control plane"
for _ in $(seq 1 60); do
  curl -fsS http://127.0.0.1:3000/api/healthz >/dev/null 2>&1 && break
  sleep 5
done
curl -fsS http://127.0.0.1:3000/api/healthz >/dev/null || { "$BASE/compose.sh" logs --tail 50 control-plane; exit 1; }
say "control plane is up"

say "waiting for the certificate for $HOST"
for _ in $(seq 1 36); do
  code="$(curl -s -o /dev/null -w '%{http_code}' --resolve "$HOST:443:127.0.0.1" "https://$HOST/api/internal/sync" || true)"
  [[ "$code" == 401 ]] && { say "HTTPS ready (sync endpoint answers 401 without a token, as expected)"; exit 0; }
  sleep 5
done
say "certificate not ready yet; check: $BASE/compose.sh logs caddy"
