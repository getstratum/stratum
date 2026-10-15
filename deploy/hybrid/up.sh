#!/usr/bin/env bash
# Hybrid test: the control plane on one small GCP VM, the gateway wherever
# you run it (your laptop, your datacenter). Run from Cloud Shell.
#
#   PROJECT_ID=my-project CONSOLE_CIDR=203.0.113.10/32 ./up.sh
#
# CONSOLE_CIDR is the public IP that may open the console (curl ifconfig.me
# on your laptop). Gateways sync from anywhere with their sync token.
#
# Creates: a VPC, two firewall rules, one e2-medium VM (~US$0.04/hour).
# Delete everything with ./down.sh.
set -euo pipefail

PROJECT_ID="${PROJECT_ID:-$(gcloud config get-value project 2>/dev/null)}"
REGION="${REGION:-us-central1}"
ZONE="${ZONE:-${REGION}-a}"
NAME="${NAME:-stratum-cp}"
NET="${NET:-stratum-hybrid}"
CONSOLE_CIDR="${CONSOLE_CIDR:?set CONSOLE_CIDR to your public IP, e.g. 203.0.113.10/32}"
DIR="$(cd "$(dirname "$0")" && pwd)"

[[ -n "$PROJECT_ID" ]] || { echo "set PROJECT_ID" >&2; exit 1; }
g() { gcloud --project "$PROJECT_ID" --quiet "$@"; }
step() { printf '\n==> %s\n' "$*"; }

step "APIs"
g services enable compute.googleapis.com iap.googleapis.com >/dev/null

step "Network and firewall"
g compute networks describe "$NET" >/dev/null 2>&1 ||
  g compute networks create "$NET" --subnet-mode=custom >/dev/null
g compute networks subnets describe "$NET" --region "$REGION" >/dev/null 2>&1 ||
  g compute networks subnets create "$NET" --network "$NET" --region "$REGION" --range 10.60.0.0/24 >/dev/null
# HTTPS for everyone (the sync endpoint needs a token; Caddy limits the
# console to CONSOLE_CIDR); HTTP only for the certificate challenge.
g compute firewall-rules describe "$NET-web" >/dev/null 2>&1 ||
  g compute firewall-rules create "$NET-web" --network "$NET" --allow tcp:80,tcp:443 \
    --source-ranges 0.0.0.0/0 --target-tags "$NAME" >/dev/null
# SSH only through Identity-Aware Proxy, never from the internet.
g compute firewall-rules describe "$NET-iap-ssh" >/dev/null 2>&1 ||
  g compute firewall-rules create "$NET-iap-ssh" --network "$NET" --allow tcp:22 \
    --source-ranges 35.235.240.0/20 --target-tags "$NAME" >/dev/null

step "VM $NAME ($ZONE)"
if ! g compute instances describe "$NAME" --zone "$ZONE" >/dev/null 2>&1; then
  g compute instances create "$NAME" --zone "$ZONE" --machine-type e2-medium \
    --subnet "$NET" --tags "$NAME" \
    --image-family debian-12 --image-project debian-cloud --boot-disk-size 30GB \
    --shielded-secure-boot --shielded-vtpm --shielded-integrity-monitoring \
    --metadata enable-oslogin=TRUE >/dev/null
fi
IP="$(g compute instances describe "$NAME" --zone "$ZONE" --format='value(networkInterfaces[0].accessConfigs[0].natIP)')"
HOST="${IP//./-}.sslip.io"
echo "  external IP $IP  ->  https://$HOST"

step "Waiting for SSH (through IAP)"
for _ in $(seq 1 30); do
  g compute ssh "$NAME" --zone "$ZONE" --tunnel-through-iap --command true >/dev/null 2>&1 && break
  sleep 10
done

step "Installing Docker and starting the control plane (first build takes ~10 minutes)"
g compute scp --zone "$ZONE" --tunnel-through-iap "$DIR/vm/setup.sh" "$DIR/vm/bootstrap.sh" "$NAME:/tmp/" >/dev/null
g compute ssh "$NAME" --zone "$ZONE" --tunnel-through-iap \
  --command "sudo HOST='$HOST' CONSOLE_CIDR='$CONSOLE_CIDR' bash /tmp/setup.sh"

cat <<EOF

Control plane: https://$HOST  (console from $CONSOLE_CIDR only)

Next: register your gateway and your Claude key (asks for the key, not echoed):
  gcloud compute ssh $NAME --zone $ZONE --tunnel-through-iap --project $PROJECT_ID --ssh-flag=-t \\
    --command 'sudo bash /opt/stratum/bootstrap.sh'
EOF
