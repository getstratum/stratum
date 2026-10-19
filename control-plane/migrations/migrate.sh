#!/bin/sh
# Applies control plane migrations in order, each one exactly once.
#
# Applied files are recorded in schema_migrations. A database created before
# this runner existed (tables present, no schema_migrations) is baselined:
# files up to BASELINE are marked as applied and only later ones run.
#
# Everything runs in one psql session holding an advisory lock, so two
# runners started at the same time cannot apply the same file twice. Files
# manage their own transactions; the first error stops the run.
#
# Usage: migrate.sh <dir>   with PGHOST, PGUSER, PGDATABASE, PGPASSWORD set,
#                           or DATABASE_URL (a libpq connection URI, which
#                           takes precedence).
set -eu

DIR="${1:-/migrations}"
BASELINE="012_stratum_sync.sql"
LOCK_ID=4723001
export PGOPTIONS="${PGOPTIONS:-} -c client_min_messages=warning"

files=$(ls "$DIR"/*.sql | sort)

# Files that a pre-existing database is assumed to have applied already.
baseline=""
for f in $files; do
  name=$(basename "$f")
  baseline="$baseline${baseline:+,}'$name'"
  [ "$name" = "$BASELINE" ] && break
done

script=$(mktemp)
trap 'rm -f "$script"' EXIT
{
  printf '%s\n' '\o /dev/null'
  printf '%s\n' "SELECT pg_advisory_lock($LOCK_ID);"
  printf '%s\n' '\o'
  printf '%s\n' "CREATE TABLE IF NOT EXISTS schema_migrations (
  filename   TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);"
  printf '%s\n' "INSERT INTO schema_migrations (filename)
  SELECT unnest(ARRAY[$baseline])
  WHERE NOT EXISTS (SELECT 1 FROM schema_migrations)
    AND to_regclass('public.organizations') IS NOT NULL;"
  for f in $files; do
    name=$(basename "$f")
    printf '%s\n' "SELECT NOT EXISTS (SELECT 1 FROM schema_migrations WHERE filename = '$name') AS pending \\gset"
    printf '%s\n' '\if :pending'
    printf '%s\n' "\\echo '--> $name'"
    printf '%s\n' "\\i $f"
    printf '%s\n' "INSERT INTO schema_migrations (filename) VALUES ('$name');"
    printf '%s\n' '\endif'
  done
  printf '%s\n' "\\echo '==> Migrations up to date.'"
} > "$script"

# The control plane's DATABASE_URL works here too, so one secret serves both.
if [ -n "${DATABASE_URL:-}" ]; then set -- -d "$DATABASE_URL"; else set --; fi
psql -X -q -v ON_ERROR_STOP=1 "$@" -f "$script"
