#!/bin/bash
# Stratum — Migration runner (shell wrapper)
# Usage: ./scripts/migrate.sh
# Or via Docker: docker exec -it $(docker compose ps -q proxy) node /app/scripts/migrate.js

set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
node "$SCRIPT_DIR/migrate.js"
