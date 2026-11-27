#!/bin/sh
# Writes .env for this non-production Stratum, with its own secrets, once.
#   ./init.sh <console host> <gateway host> "<organization>" <owner email> [version]
# Keep .env: its STRATUM_ENCRYPTION_KEY reads the providers' keys and the
# second factors; without it they are lost.
set -eu
cd "$(dirname "$0")"
[ $# -ge 4 ] || { echo 'usage: ./init.sh consola.example.com gateway.example.com "Acme (pruebas)" ana@acme.com [version]' >&2; exit 2; }
[ -e .env ] && { echo ".env exists: it holds this installation's secrets; not replaced." >&2; exit 1; }
hex() { od -An -N"$1" -tx1 /dev/urandom | tr -d ' \n'; }
version="${5:-$(sed -n 's/^appVersion: "\(.*\)".*/\1/p' ../helm/stratum/Chart.yaml)}"
umask 077
cat > .env <<ENV
# Stratum non-production: its secrets. Made by init.sh; keep it safe.
STRATUM_VERSION=$version
STRATUM_CONSOLE_HOST=$1
STRATUM_GATEWAY_HOST=$2
STRATUM_ORG_NAME=$3
STRATUM_OWNER_EMAIL=$4
POSTGRES_PASSWORD=$(hex 24)
STRATUM_ENCRYPTION_KEY=$(hex 32)
STRATUM_SNAPSHOT_KEY=$(hex 32)
STRATUM_INSTANCE_ID=dp_$(hex 16)
STRATUM_SYNC_TOKEN=dp_sync_$(hex 32)
STRATUM_VALKEY_PASSWORD=$(hex 24)
# "tls internal" on a private network (Caddy's own CA); empty: Let's Encrypt.
STRATUM_TLS=
# Alerts and invitations by email: smtp://user:password@host:587
STRATUM_SMTP_URL=
STRATUM_BACKUP_DAYS=7
ENV
echo "Wrote .env (Stratum $version). Next: docker compose up -d --wait, then docker compose logs bootstrap."
