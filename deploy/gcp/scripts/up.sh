#!/usr/bin/env bash
# Creates the infrastructure with Terraform (about 20-25 minutes: Cloud SQL
# and Memorystore take the longest).
#
#   PROJECT_ID=my-project CONSOLE_CIDR=203.0.113.10/32 ./up.sh
#
# On the first run it writes terraform/terraform.tfvars; edit that file for
# region, domain, alert e-mail or budget before running again.
# shellcheck source-path=SCRIPTDIR source=lib.sh
source "$(dirname "$0")/lib.sh"
require gcloud jq openssl
require_terraform

TFVARS="$TF_DIR/terraform.tfvars"

if [[ ! -f "$TFVARS" ]]; then
  step "First run: writing terraform/terraform.tfvars"
  project="${PROJECT_ID:-$(gcloud config get-value project 2>/dev/null || true)}"
  [[ -n "$project" ]] || read -r -p "  GCP project id: " project
  cidr="${CONSOLE_CIDR:-}"
  if [[ -z "$cidr" ]]; then
    echo "  The console only accepts your workstation's public IP."
    echo "  On your laptop (not Cloud Shell) run: curl -s ifconfig.me"
    read -r -p "  Your public IP: " ip
    cidr="${ip}/32"
  fi
  suffix="$(openssl rand -hex 3)"
  cat >"$TFVARS" <<EOF
project_id            = "$project"
region                = "${REGION:-us-central1}"
env                   = "${STRATUM_ENV:-test}"
suffix                = "$suffix"
console_allowed_cidrs = ["$cidr"]
# domain            = ""     # empty = <edge-ip>.sslip.io
# alert_email       = ""
# metric_alerts     = false  # set true and re-run 'make up' after 'make deploy'
# billing_account   = ""     # XXXXXX-XXXXXX-XXXXXX, enables a budget alert
# budget_amount_usd = 30
EOF
  ok "wrote $TFVARS"
fi

project="$(sed -n 's/^project_id *= *"\(.*\)"/\1/p' "$TFVARS")"
step "Checking project $project"
gcloud projects describe "$project" --format='value(projectId)' >/dev/null ||
  die "project $project not found or no access"
billing="$(gcloud billing projects describe "$project" --format='value(billingEnabled)' 2>/dev/null || true)"
[[ "$billing" == "True" ]] || warn "could not confirm billing is enabled on $project (needed for every service used)"

step "Enabling APIs (also declared in Terraform; doing it first avoids propagation errors)"
# A new project allows few Service Usage changes per minute, and enabling one
# API also enables what it depends on: enabling all of them in one request can
# get 429 (RESOURCE_EXHAUSTED) on every try. So enable only what is missing,
# one at a time, and wait when the quota runs out.
apis=(cloudresourcemanager serviceusage iam compute container sqladmin
  servicenetworking memorystore networkconnectivity certificatemanager
  artifactregistry cloudbuild secretmanager monitoring logging)
enabled="$(gcloud services list --enabled --project "$project" --format='value(config.name)' 2>/dev/null || true)"
for api in "${apis[@]}"; do
  svc="$api.googleapis.com"
  grep -qx "$svc" <<<"$enabled" && continue
  for attempt in 1 2 3 4 5 6; do
    if err="$(gcloud services enable "$svc" --project "$project" 2>&1)"; then
      ok "$svc"
      break
    fi
    if ! grep -q RESOURCE_EXHAUSTED <<<"$err" || ((attempt == 6)); then
      echo "$err" >&2
      die "could not enable $svc; run 'make up' again later (what is enabled stays enabled)"
    fi
    warn "$svc: Service Usage quota exhausted (attempt $attempt); trying again in 90 s"
    sleep 90
  done
done
ok "APIs enabled"

step "terraform init"
"$TF" -chdir="$TF_DIR" init -upgrade -input=false >/dev/null
ok "providers installed"

step "terraform apply"
# APIs enabled in this same run can take a minute to propagate; a second
# apply picks up whatever failed for that reason.
if ! "$TF" -chdir="$TF_DIR" apply -input=false -auto-approve; then
  warn "apply failed; retrying once in 60 s (API enablement propagation is the usual cause)"
  sleep 60
  "$TF" -chdir="$TF_DIR" apply -input=false -auto-approve
fi

load_outputs
step "Infrastructure ready"
cat <<EOF
  project      $PROJECT_ID ($REGION)
  hostname     https://$HOST   (certificate is issued after 'make deploy' creates the load balancer)
  egress IP    $EGRESS_IP
  next step    make deploy
EOF
if ! grep -q '^metric_alerts *= *true' "$TFVARS"; then
  echo "  SLO alerts are off until the gateway exports metrics: after 'make deploy',"
  echo "  set metric_alerts = true in terraform/terraform.tfvars and run 'make up' again."
fi
