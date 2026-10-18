#!/usr/bin/env bash
# Builds the images from this checkout and deploys Stratum on the
# environment created by up.sh. Safe to re-run: secrets are generated once
# and kept in Secret Manager; everything else is applied idempotently.
#
# Options (environment):
#   SKIP_BUILD=1 IMAGE_TAG=<tag>   reuse images already in Artifact Registry
#   BUILD_WITH=docker              build locally instead of Cloud Build
#   OPENAI_API_KEY / ANTHROPIC_API_KEY   also register real providers
#   CERT_WAIT_MINUTES=45           how long to wait for the TLS certificate
# shellcheck source-path=SCRIPTDIR source=lib.sh
source "$(dirname "$0")/lib.sh"
require gcloud kubectl helm jq envsubst openssl curl
load_outputs
export SQL_DATABASE

step "Cluster credentials ($CLUSTER_NAME, DNS endpoint)"
kube_credentials
ok "connected"

# ── 1. Edge first: the certificate is issued only once the load balancer
#       exists, so start that clock before the slow steps. ─────────────────
step "Namespace and load balancer (Gateway API)"
render "$GCP_DIR/k8s/base.yaml" | kubectl apply -f - >/dev/null
render "$GCP_DIR/k8s/edge.yaml" | k apply -f - >/dev/null
ok "gateway 'stratum-edge' applied; certificate for $HOST is now provisioning"

# ── 2. Images ────────────────────────────────────────────────────────────
TAG="${IMAGE_TAG:-$(git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null || echo local)-$(date -u +%m%d%H%M)}"
if [[ "${SKIP_BUILD:-0}" != "1" ]]; then
  step "Building images ($TAG)"
  if [[ "${BUILD_WITH:-cloudbuild}" == "docker" ]]; then
    require docker
    gcloud auth configure-docker "${REGION}-docker.pkg.dev" --quiet >/dev/null
    docker build -t "$IMAGE_REPO/stratum-gateway:$TAG" "$REPO_ROOT/gateway"
    docker build --build-arg "NEXT_PUBLIC_GATEWAY_URL=https://$HOST" -t "$IMAGE_REPO/stratum-control-plane:$TAG" "$REPO_ROOT/control-plane/dashboard"
    docker build -t "$IMAGE_REPO/mock-llm:$TAG" "$GCP_DIR/mock-llm"
    for i in stratum-gateway stratum-control-plane mock-llm; do docker push -q "$IMAGE_REPO/$i:$TAG"; done
  else
    # Paths are relative to the repository root (the uploaded source). Logs
    # go to Cloud Logging only (custom build identity), so poll the status
    # instead of streaming.
    build_id="$(cd "$REPO_ROOT" && gcloud builds submit . --project "$PROJECT_ID" --region "$REGION" \
      --config deploy/gcp/cloudbuild.yaml \
      --ignore-file deploy/gcp/.gcloudignore \
      --service-account "$BUILD_SERVICE_ACCOUNT" \
      --default-buckets-behavior regional-user-owned-bucket \
      --substitutions "_REPO=$IMAGE_REPO,_TAG=$TAG,_PUBLIC_URL=https://$HOST" \
      --async --format='value(id)')"
    echo "  build $build_id: https://console.cloud.google.com/cloud-build/builds;region=$REGION/$build_id?project=$PROJECT_ID"
    while :; do
      status="$(gcloud builds describe "$build_id" --project "$PROJECT_ID" --region "$REGION" --format='value(status)')"
      case "$status" in
        SUCCESS) ok "images built"; break ;;
        QUEUED|PENDING|WORKING) printf '  %s  %s\n' "$(date -u +%H:%M:%S)" "$status"; sleep 20 ;;
        *) die "build $build_id ended with $status (see the link above)" ;;
      esac
    done
  fi
fi

digest() {
  gcloud artifacts docker images describe "$IMAGE_REPO/$1:$TAG" --project "$PROJECT_ID" \
    --format='value(image_summary.digest)' 2>/dev/null || die "image $1:$TAG not found in $IMAGE_REPO"
}
GATEWAY_DIGEST="$(digest stratum-gateway)"
CP_DIGEST="$(digest stratum-control-plane)"
MOCK_DIGEST="$(digest mock-llm)"
export CP_IMAGE="$IMAGE_REPO/stratum-control-plane@$CP_DIGEST"
export MOCK_IMAGE="$IMAGE_REPO/mock-llm@$MOCK_DIGEST"
ok "images pinned by digest"

if ! gcloud container images describe "$PROXY_IMAGE" >/dev/null 2>&1; then
  warn "could not verify $PROXY_IMAGE; set PROXY_IMAGE to a current gcr.io/cloud-sql-connectors/cloud-sql-proxy:2.x tag if pods fail to pull it"
fi

# ── 3. Secrets: generated once, stored in Secret Manager, mirrored into
#       Kubernetes secrets. Nothing secret goes through Terraform state. ───
step "Secrets"
DB_PASSWORD="$(sm_ensure db-password b64_24)"
if gcloud sql users list --instance "$SQL_INSTANCE" --project "$PROJECT_ID" --format='value(name)' | grep -qx stratum; then
  gcloud sql users set-password stratum --instance "$SQL_INSTANCE" --project "$PROJECT_ID" --password "$DB_PASSWORD" --quiet >/dev/null
else
  gcloud sql users create stratum --instance "$SQL_INSTANCE" --project "$PROJECT_ID" --password "$DB_PASSWORD" --quiet >/dev/null
fi
CONSOLE_PASSWORD="$(sm_ensure console-password b64_24)"
CONSOLE_TOTP="$(sm_ensure console-totp b32_20)"
ENCRYPTION_KEY="$(sm_ensure encryption-key hex32)"
SNAPSHOT_KEY="$(sm_ensure snapshot-key hex32)"
ENG_KEY="$(sm_ensure key-engineering sh -c 'echo "sk-stratum-$(openssl rand -hex 24)"')"
MKT_KEY="$(sm_ensure key-marketing sh -c 'echo "sk-stratum-$(openssl rand -hex 24)"')"

kube_secret stratum-db username=stratum "password=$DB_PASSWORD"
kube_secret stratum-control-plane \
  "DATABASE_URL=postgres://stratum:${DB_PASSWORD}@127.0.0.1:5432/${SQL_DATABASE}" \
  "STRATUM_ENCRYPTION_KEY=$ENCRYPTION_KEY"
kube_secret stratum-test-keys "engineering=$ENG_KEY" "marketing=$MKT_KEY"
ok "Secret Manager: ${SECRET_PREFIX}-* ; Kubernetes: stratum-db, stratum-control-plane, stratum-test-keys"

# ── 4. Database: migrations, then the test bootstrap ───────────────────────
step "Database migrations"
k create configmap stratum-migrations --from-file="$REPO_ROOT/control-plane/migrations" \
  --dry-run=client -o yaml | k apply -f - >/dev/null
run_sql_job stratum-migrate stratum-migrations '["sh", "/sql/migrate.sh", "/sql"]'

step "Bootstrap: rotate published demo keys, set test policies"
ENG_HASH="$(printf '%s' "$ENG_KEY" | sha256sum | cut -d' ' -f1)"
MKT_HASH="$(printf '%s' "$MKT_KEY" | sha256sum | cut -d' ' -f1)"
k create configmap stratum-bootstrap --from-file="$GCP_DIR/sql/bootstrap.sql" \
  --dry-run=client -o yaml | k apply -f - >/dev/null
run_sql_job stratum-bootstrap stratum-bootstrap \
  "[\"psql\", \"-X\", \"-v\", \"eng_hash=$ENG_HASH\", \"-v\", \"mkt_hash=$MKT_HASH\", \"-f\", \"/sql/bootstrap.sql\"]"

# ── 5. Control plane, mock provider, policies, monitoring ──────────────────
step "Control plane and mock provider"
render "$GCP_DIR/k8s/control-plane.yaml" | k apply -f - >/dev/null
render "$GCP_DIR/k8s/mock-llm.yaml" | k apply -f - >/dev/null
render "$GCP_DIR/k8s/network-policy.yaml" | k apply -f - >/dev/null
render "$GCP_DIR/k8s/monitoring.yaml" | k apply -f - >/dev/null
k rollout status deployment/stratum-control-plane --timeout=15m
k rollout status deployment/mock-llm --timeout=10m
ok "control plane and mock-llm ready"

# The console has no default account: make dev@acme.com the demo
# organization's owner, with a password kept in Secret Manager. Owners must
# use a second factor: its authenticator secret is in Secret Manager too
# ('make keys' prints it to add to an authenticator app).
printf '%s' "$CONSOLE_PASSWORD" | k exec -i deploy/stratum-control-plane -c control-plane -- \
  node scripts/stratum-admin.mjs create-owner --email dev@acme.com \
  --org-id 00000000-0000-0000-0000-000000000001 --password-stdin >/dev/null
printf '%s' "$CONSOLE_TOTP" | k exec -i deploy/stratum-control-plane -c control-plane -- \
  node scripts/stratum-admin.mjs enroll-mfa --email dev@acme.com --secret-stdin >/dev/null
ok "console owner: dev@acme.com (with a second factor)"

# ── 6. Register the gateway and providers through the control plane API ───
step "Registering the gateway instance and providers"
port_forward svc/stratum-cp-console 13000:80
CP=http://127.0.0.1:13000
CHALLENGE="$(jq -n --arg e dev@acme.com --arg p "$CONSOLE_PASSWORD" '{email:$e,password:$p}' |
  curl -sS -H 'content-type: application/json' --data-binary @- "$CP/api/session" | jq -r '.challenge // empty')"
[[ -n "$CHALLENGE" ]] || die "could not log in to the control plane (password step)"
COOKIE="$(jq -n --arg c "$CHALLENGE" --arg k "$(totp_code "$CONSOLE_TOTP")" '{challenge:$c,code:$k}' |
  curl -sS -D - -o /dev/null -H 'content-type: application/json' --data-binary @- "$CP/api/session/mfa" |
  tr -d '\r' | sed -n 's/^[Ss]et-[Cc]ookie: \(stratum_session=[^;]*\).*/\1/p')"
[[ -n "$COOKIE" ]] || die "could not log in to the control plane (second factor)"

api() { curl -sS -f -H "Cookie: $COOKIE" -H 'content-type: application/json' "$@"; }

if ! SYNC_TOKEN="$(sm_get sync-token)" || [[ -z "$SYNC_TOKEN" ]]; then
  reg="$(api -d "$(jq -n --arg n "gke-$REGION" '{label:$n}')" "$CP/api/internal/instances")"
  SYNC_TOKEN="$(jq -r .sync_token <<<"$reg")"
  INSTANCE_ID="$(jq -r .id <<<"$reg")"
  sm_put sync-token "$SYNC_TOKEN"
  sm_put instance-id "$INSTANCE_ID"
  ok "registered instance $INSTANCE_ID"
else
  INSTANCE_ID="$(sm_get instance-id)"
  ok "reusing instance $INSTANCE_ID"
fi

provider() { # slug display key [base_url]
  local body
  body="$(jq -n --arg p "$1" --arg d "$2" --arg k "$3" --arg b "${4:-}" \
    '{provider:$p, display_name:$d, api_key:$k} + (if $b == "" then {} else {base_url:$b} end)')"
  printf '%s' "$body" | api -o /dev/null --data-binary @- "$CP/api/internal/providers" && ok "provider $1"
}
provider ollama "Mock LLM (tests)" mock "http://mock-llm.${NAMESPACE}.svc.cluster.local:8080"
[[ -n "${OPENAI_API_KEY:-}" ]] && provider openai "OpenAI" "$OPENAI_API_KEY"
[[ -n "${ANTHROPIC_API_KEY:-}" ]] && provider anthropic "Anthropic" "$ANTHROPIC_API_KEY"
cleanup_pf

kube_secret stratum-gateway "STRATUM_SYNC_TOKEN=$SYNC_TOKEN" "STRATUM_INSTANCE_ID=$INSTANCE_ID" \
  "STRATUM_SNAPSHOT_KEY=$SNAPSHOT_KEY"

# ── 7. Certificate: gateways sync over the public HTTPS endpoint ───────────
step "Waiting for the TLS certificate for $HOST"
deadline=$(( $(date +%s) + ${CERT_WAIT_MINUTES:-45} * 60 ))
state=""
while (( $(date +%s) < deadline )); do
  state="$(gcloud certificate-manager certificates describe "$CERTIFICATE_NAME" --project "$PROJECT_ID" \
    --format='value(managed.state)' 2>/dev/null || true)"
  [[ "$state" == "ACTIVE" ]] && break
  printf '  %s  state=%s\n' "$(date -u +%H:%M:%S)" "${state:-unknown}"
  sleep 30
done
CP_URL="https://$HOST"
ALLOW_HTTP=false
if [[ "$state" != "ACTIVE" ]]; then
  warn "certificate not active yet ($state). Gateways will sync in-cluster for now; re-run 'make deploy SKIP_BUILD=1 IMAGE_TAG=$TAG' later to switch to HTTPS."
  CP_URL="http://stratum-cp-sync.${NAMESPACE}.svc"
  ALLOW_HTTP=true
else
  ok "certificate active"
fi

# ── 8. Gateway (data plane) ────────────────────────────────────────────────
step "Gateway: Helm release stratum-gateway"
helm upgrade --install stratum-gateway "$REPO_ROOT/deploy/helm/stratum-gateway" \
  --namespace "$NAMESPACE" \
  -f "$GCP_DIR/helm/values-gcp.yaml" \
  --set "image.repository=$IMAGE_REPO/stratum-gateway" \
  --set "image.digest=$GATEWAY_DIGEST" \
  --set "controlPlane.url=$CP_URL" \
  --set "controlPlane.allowHTTP=$ALLOW_HTTP" \
  --set "quota.valkey.url=redis://$VALKEY_ADDRESS/0" \
  --wait --timeout 20m
ok "gateway ready"

# ── 9. Edge: the load balancer routes to the gateways ──────────────────────
# Right after the first deploy the load balancer answers 500 until its
# backends are programmed (minutes). Wait for 30 consecutive 200s on /readyz
# through it, so "Done" means the API answers.
step "Waiting for the load balancer to route to the gateways"
deadline=$(( $(date +%s) + ${EDGE_WAIT_MINUTES:-20} * 60 ))
streak=0
while (( streak < 30 && $(date +%s) < deadline )); do
  c="$(curl -sS -o /dev/null -m 5 -w '%{http_code}' "https://$HOST/readyz" 2>/dev/null || echo 000)"
  if [[ "$c" == 200 ]]; then streak=$((streak + 1)); else
    ((streak > 0)) && printf '  %s  %s after %s good answers\n' "$(date -u +%H:%M:%S)" "$c" "$streak"
    streak=0
  fi
  sleep 2
done
if ((streak >= 30)); then
  ok "https://$HOST/readyz answered 200 thirty times in a row"
else
  warn "the load balancer is not routing reliably yet; wait a few minutes before testing"
fi

step "Done"
cat <<EOF
  API        https://$HOST/v1/chat/completions   (model "ollama/mock-1")
  Console    https://$HOST   (from ${c_yellow}your allowlisted IP only${c_off})
             login: dev@acme.com  /  password from 'make keys'
  Keys       make keys
  Tests      make test            (all scenarios, ~45 min)
             make test-smoke      (one scenario: smoke|warmup|quota|rollout|zone|valkey|cp-outage|sql-failover)
             make test-console    (the console in a browser; needs Node.js)
  Teardown   make down            ${c_yellow}(do not forget: ~US\$0.5/hour while it runs)${c_off}
EOF
if ! grep -q '^metric_alerts *= *true' "$TF_DIR/terraform.tfvars" 2>/dev/null; then
  warn "SLO alerts are not created yet. The gateway is exporting metrics now: set"
  warn "metric_alerts = true in terraform/terraform.tfvars and run 'make up' (about 1 minute)."
fi
