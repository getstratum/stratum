#!/usr/bin/env bash
# Deletes what up.sh created: the VM (and its disk), the firewall rules and
# the network. Nothing else in the project is touched.
set -euo pipefail
PROJECT_ID="${PROJECT_ID:-$(gcloud config get-value project 2>/dev/null)}"
REGION="${REGION:-us-central1}"
ZONE="${ZONE:-${REGION}-a}"
NAME="${NAME:-stratum-cp}"
NET="${NET:-stratum-hybrid}"
g() { gcloud --project "$PROJECT_ID" --quiet "$@"; }

g compute instances delete "$NAME" --zone "$ZONE" --delete-disks=all 2>/dev/null || true
for r in "$NET-web" "$NET-iap-ssh"; do g compute firewall-rules delete "$r" 2>/dev/null || true; done
g compute networks subnets delete "$NET" --region "$REGION" 2>/dev/null || true
g compute networks delete "$NET" 2>/dev/null || true
echo "deleted. Left in the project:"
g compute instances list --filter="name=$NAME" --format='value(name)'
g compute networks list --filter="name=$NET" --format='value(name)'
