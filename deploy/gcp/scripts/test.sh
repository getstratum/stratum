#!/usr/bin/env bash
# Test plan for the HA claims. Each scenario prints a verdict and appends it
# to deploy/gcp/.results/<date>.md.
#
#   ./test.sh all | smoke | quota | quota-reset | rollout | zone [--hard]
#             | valkey | cp-outage | sql-failover
#
# Load comes from k6 inside the cluster through the public hostname, so the
# load balancer, TLS and Cloud Armor are part of every measurement.
# shellcheck source-path=SCRIPTDIR source=lib.sh
source "$(dirname "$0")/lib.sh"
require gcloud kubectl jq envsubst curl
load_outputs
kube_credentials >/dev/null

ENG_KEY="$(k get secret stratum-test-keys -o jsonpath='{.data.engineering}' | base64 -d)"
MKT_KEY="$(k get secret stratum-test-keys -o jsonpath='{.data.marketing}' | base64 -d)"
API="https://$HOST/v1/chat/completions"
VALKEY_IP="${VALKEY_ADDRESS%%:*}"
export VALKEY_IP

pass() { ok "PASS $*"; record "- PASS $(date -u +%H:%M) $*"; }
fail() { warn "FAIL $*"; record "- FAIL $(date -u +%H:%M) $*"; FAILED=1; }
FAILED=0

call() { # key [stream] -> http code
  local stream="${2:-false}"
  curl -sS -o /dev/null -w '%{http_code}' --max-time 60 -H "Authorization: Bearer $1" \
    -H 'content-type: application/json' \
    -d "{\"model\":\"ollama/mock-1\",\"stream\":$stream,\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}" "$API" || echo 000
}

gateway_pods() { k get pods -l app.kubernetes.io/name=stratum-gateway -o jsonpath='{range .items[*]}{.metadata.name}{"\n"}{end}'; }
ready_gateways() { k get pods -l app.kubernetes.io/name=stratum-gateway -o json | jq '[.items[] | select(.status.conditions[]? | select(.type=="Ready" and .status=="True"))] | length'; }

# metric NAME: value of a gauge/counter summed over every gateway pod.
metric() {
  local total=0 port=19090 v
  for p in $(gateway_pods); do
    port=$((port + 1))
    port_forward "pod/$p" "$port:9090"
    v="$(curl -s "http://127.0.0.1:$port/metrics" | awk -v m="$1" '$1==m {print $2}')"
    total=$((total + ${v:-0}))
    cleanup_pf
  done
  echo "$total"
}

# ── k6 ──────────────────────────────────────────────────────────────────────
start_load() { # name rate duration
  export JOB_NAME="k6-$1" RATE="$2" DURATION="$3"
  k create configmap stratum-loadtest --from-file="$GCP_DIR/loadtest/k6.js" --dry-run=client -o yaml | k apply -f - >/dev/null
  k delete job "$JOB_NAME" --ignore-not-found --wait=true >/dev/null
  render "$GCP_DIR/k8s/loadtest-job.yaml" | k apply -f - >/dev/null
  for _ in $(seq 1 60); do
    [[ -n "$(k get pods -l "job-name=$JOB_NAME" -o name 2>/dev/null)" ]] && break
    sleep 2
  done
  k wait --for=condition=Ready pod -l "job-name=$JOB_NAME" --timeout=5m >/dev/null
  LOAD_START="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  ok "k6 running: $RATE req/s for $DURATION (job $JOB_NAME)"
}

load_result() { # name -> prints K6_RESULT json
  local name="k6-$1" t=0
  while ((t < 3600)); do
    local s f
    s="$(k get job "$name" -o jsonpath='{.status.succeeded}')"
    f="$(k get job "$name" -o jsonpath='{.status.failed}')"
    [[ "${s:-0}" -ge 1 || "${f:-0}" -ge 1 ]] && break
    sleep 10; t=$((t + 10))
  done
  k logs "job/$name" | sed -n 's/^K6_RESULT //p' | tail -1
}

# Share of requests the path to Stratum (Cloud NAT, load balancer) may fail
# before a run is flagged. Those failures are reported, not hidden, but they
# are not Stratum's: Google's load balancer SLA is 99.99% on its own.
PATH_MAX_RATE="${PATH_MAX_RATE:-0.001}"

# What the load balancer logged for /v1/ errors during the last load, grouped
# by status and statusDetails (response_sent_by_backend = the gateway
# answered; anything else = the load balancer did).
edge_breakdown() {
  sleep 30 # log ingestion delay
  gcloud logging read --project "$PROJECT_ID" --limit=2000 --format=json "
    resource.type=\"http_load_balancer\"
    AND httpRequest.requestUrl:\"https://$HOST/v1/\"
    AND httpRequest.status>=400
    AND timestamp>=\"$LOAD_START\"" 2>/dev/null |
    jq -r 'map("\(.httpRequest.status) \(.jsonPayload.statusDetails // "(no statusDetails)")")
           | group_by(.) | map("      \(length) x \(.[0])")[]' 2>/dev/null || true
}

# judge_load LABEL JSON MAX_STRATUM [MAX_PATH]
#   MAX_STRATUM  failures attributable to the gateway (5xx or unexpected status
#                it answered, broken streams)
#   MAX_PATH     edge + network failures; default PATH_MAX_RATE of requests
judge_load() {
  local label="$1" r="$2" max="$3" max_path="${4:-}" reqs stratum path
  [[ -n "$r" ]] || { fail "$label: no k6 result"; return; }
  reqs="$(jq -r .requests <<<"$r")"
  stratum="$(jq -r '.gateway_5xx + .gateway_other + .broken_streams' <<<"$r")"
  path="$(jq -r '.edge_errors + .network_errors' <<<"$r")"
  [[ -n "$max_path" ]] || max_path="$(awk -v n="$reqs" -v f="$PATH_MAX_RATE" 'BEGIN { m = n * f; printf "%d", (m == int(m)) ? m : int(m) + 1 }')"
  jq -r '"    requests=\(.requests) 2xx=\(.status_2xx) | gateway: 5xx=\(.gateway_5xx) other=\(.gateway_other) broken_streams=\(.broken_streams) | edge=\(.edge_errors) network=\(.network_errors) | p50=\(.p50_ms|floor)ms p95=\(.p95_ms|floor)ms p99=\(.p99_ms|floor)ms"' <<<"$r"
  if ((stratum + path > 0)); then
    echo "    failures (first 100, UTC): kubectl -n $NAMESPACE logs job/$JOB_NAME | grep K6_FAILURE"
    echo "    load balancer, /v1/ errors since $LOAD_START:"
    edge_breakdown
  fi
  if ((stratum <= max)); then
    pass "$label: Stratum $stratum failed of $reqs (allowed $max)"
  else
    fail "$label: Stratum $stratum failed of $reqs (allowed $max)"
  fi
  if ((path > max_path)); then
    fail "$label: path (load balancer + network) $path failed of $reqs (allowed $max_path); not Stratum, but investigate"
  elif ((path > 0)); then
    record "- note $(date -u +%H:%M) $label: path (load balancer + network) $path failed of $reqs (allowed $max_path)"
    echo "    path (load balancer + network): $path failed, within $max_path"
  fi
}

# ── Scenarios ───────────────────────────────────────────────────────────────

t_smoke() {
  step "smoke: edge, TLS, auth, routing, streaming, console allowlist"
  local c
  c="$(curl -sS -o /dev/null -w '%{http_code}' "https://$HOST/readyz" || echo 000)"
  [[ "$c" == 200 ]] && pass "smoke: /readyz through the load balancer" || fail "smoke: /readyz returned $c"
  c="$(call "$ENG_KEY")"
  [[ "$c" == 200 ]] && pass "smoke: unary completion" || fail "smoke: unary completion returned $c"
  local body
  body="$(curl -sS -N --max-time 60 -H "Authorization: Bearer $ENG_KEY" -H 'content-type: application/json' \
    -d '{"model":"ollama/mock-1","stream":true,"messages":[{"role":"user","content":"hi"}]}' "$API" || true)"
  grep -q 'data: \[DONE\]' <<<"$body" && pass "smoke: streamed completion" || fail "smoke: stream did not complete"
  c="$(call "sk-not-a-key")"
  [[ "$c" == 401 ]] && pass "smoke: unknown key rejected (401)" || fail "smoke: unknown key returned $c"
  c="$(curl -sS -o /dev/null -w '%{http_code}' -H "Authorization: Bearer aig_sk_eng_test1234567890" \
    -H 'content-type: application/json' -d '{"model":"ollama/mock-1","messages":[]}' "$API" || echo 000)"
  [[ "$c" == 401 ]] && pass "smoke: published demo key no longer works" || fail "smoke: published demo key returned $c"
  c="$(curl -sS -o /dev/null -w '%{http_code}' "http://$HOST/readyz" || echo 000)"
  [[ "$c" == 301 ]] && pass "smoke: http redirects to https" || fail "smoke: http returned $c"
  c="$(curl -sS -o /dev/null -w '%{http_code}' "https://$HOST/" || echo 000)"
  echo "    console from this machine ($(curl -s ifconfig.me 2>/dev/null || echo '?')): HTTP $c (403 unless this IP is allowlisted)"
}

t_quota() {
  step "quota: Marketing has 3000 tokens/month = 30 requests of 100 tokens, enforced across all replicas"
  local passed=0 first429=0 c
  # Warm-up: the first request marks the team as active, so every replica
  # refreshes its total from Valkey within a second.
  c="$(call "$MKT_KEY")"
  if [[ "$c" == 200 ]]; then passed=1; else sleep 2; fi
  for i in $(seq 2 80); do
    c="$(call "$MKT_KEY")"
    if [[ "$c" == 200 ]]; then passed=$((passed + 1)); elif [[ "$c" == 429 && $first429 == 0 ]]; then first429=$i; fi
    [[ $first429 -gt 0 && $i -ge $((first429 + 5)) ]] && break
    sleep 0.2
  done
  local replicas; replicas="$(ready_gateways)"
  echo "    replicas=$replicas accepted=$passed first_429_at=$first429"
  # Counters converge within ~2 flush intervals (one replica writes, the
  # others read on their next flush). At ~5 req/s that is up to ~10
  # requests of overspend. Without sharing, each replica would allow 30.
  if ((first429 > 0 && passed >= 28 && passed <= 40)); then
    pass "quota: $passed requests accepted for a limit of 30 ($replicas replicas; per-replica counters would allow up to $((30 * replicas)))"
  else
    fail "quota: $passed accepted, first 429 at $first429 (run 'make test-quota-reset' first if the quota was already used this month)"
  fi
  echo "    pending tokens (all replicas): $(metric stratum_quota_pending_tokens)  flush failures: $(metric stratum_quota_store_flush_failure_total)"
}

t_quota_reset() {
  step "quota-reset: delete this month's counters in Valkey"
  local pattern overrides
  pattern="stratum:{quota}:tok:$(date -u +%Y-%m):*"
  overrides="$(jq -n --arg img "$VALKEY_CLI_IMAGE" --arg ip "$VALKEY_IP" --arg pat "$pattern" '{
    spec: {
      securityContext: {runAsNonRoot: true, runAsUser: 999, seccompProfile: {type: "RuntimeDefault"}},
      containers: [{
        name: "valkey-cli", image: $img,
        command: ["sh", "-c", "valkey-cli -h \($ip) --scan --pattern \"\($pat)\" | xargs -r valkey-cli -h \($ip) DEL"],
        securityContext: {allowPrivilegeEscalation: false, capabilities: {drop: ["ALL"]}}
      }]
    }}')"
  k run valkey-cli --rm -i --restart=Never --image "$VALKEY_CLI_IMAGE" --overrides "$overrides" ||
    warn "valkey-cli pod failed"
  ok "counters deleted; gateways pick it up within a second (reported as a counter regression)"
}

t_rollout() {
  step "rollout: restart every gateway pod under load; target 0 failed requests"
  start_load rollout 40 8m
  sleep 60
  k rollout restart deployment/stratum-gateway >/dev/null
  k rollout status deployment/stratum-gateway --timeout=20m
  judge_load "rollout (zero-downtime deploy)" "$(load_result rollout)" 0
}

t_zone() {
  local hard="${1:-}"
  step "zone: lose every gateway pod in one zone under load ${hard:+(hard kill)}"
  local zone pods
  zone="$(k get pods -l app.kubernetes.io/name=stratum-gateway -o jsonpath='{.items[0].spec.nodeName}' |
    xargs -I{} kubectl get node {} -o jsonpath='{.metadata.labels.topology\.kubernetes\.io/zone}')"
  start_load zone 40 6m
  sleep 60
  pods="$(k get pods -l app.kubernetes.io/name=stratum-gateway -o json | jq -r --arg z "$zone" \
    '.items[] | .metadata.name + " " + .spec.nodeName' | while read -r p n; do
      # '|| true': a pod in another zone is not an error (set -e + pipefail).
      [[ "$(kubectl get node "$n" -o jsonpath='{.metadata.labels.topology\.kubernetes\.io/zone}')" == "$zone" ]] && echo "$p" || true
    done)"
  echo "    zone $zone: deleting $(echo "$pods" | wc -w) pod(s): $(tr '\n' ' ' <<<"$pods")"
  if [[ -n "$hard" ]]; then
    # shellcheck disable=SC2086
    k delete pod $pods --grace-period=0 --force >/dev/null 2>&1
  else
    # shellcheck disable=SC2086
    k delete pod $pods --wait=false >/dev/null
  fi
  if [[ -n "$hard" ]]; then
    # In-flight requests on killed pods fail by definition (broken streams,
    # or a 502 from the load balancer); the rest must not.
    judge_load "zone loss, hard kill (in-flight requests on the killed pods may fail)" "$(load_result zone)" 50 100
  else
    judge_load "zone loss, graceful" "$(load_result zone)" 0
  fi
}

t_valkey() {
  step "valkey: cut gateways off from Valkey under load; requests must not fail, usage must reconcile"
  local np
  np="$(cat <<EOF
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: chaos-block-valkey
  namespace: $NAMESPACE
spec:
  podSelector:
    matchLabels:
      app.kubernetes.io/name: stratum-gateway
  policyTypes: ["Egress"]
  egress:
    # Pods and services in the cluster (mock provider, DNS). Dataplane V2
    # does not match pod IPs with ipBlock, so they need their own rule.
    - to:
        - namespaceSelector: {}
    # Everything outside the cluster except Valkey's endpoint.
    - to:
        - ipBlock:
            cidr: 0.0.0.0/0
            except: ["$VALKEY_IP/32"]
EOF
)"
  local before; before="$(metric stratum_quota_store_flush_failure_total)"
  start_load valkey 20 4m
  sleep 30
  kubectl apply -f - <<<"$np" >/dev/null
  echo "    Valkey blocked at $(date -u +%H:%M:%S)"
  sleep 90
  local failures pending
  failures="$(metric stratum_quota_store_flush_failure_total)"
  pending="$(metric stratum_quota_pending_tokens)"
  echo "    during outage: flush failures +$((failures - before)), pending tokens $pending"
  k delete networkpolicy chaos-block-valkey >/dev/null
  echo "    Valkey restored at $(date -u +%H:%M:%S)"
  judge_load "valkey outage: requests unaffected" "$(load_result valkey)" 0
  sleep 10
  pending="$(metric stratum_quota_pending_tokens)"
  ((failures > before)) && pass "valkey outage: detected (flush failures increased)" || fail "valkey outage: no flush failures recorded"
  ((pending == 0)) && pass "valkey outage: backlog reconciled (0 pending tokens)" || fail "valkey outage: $pending tokens still pending"
}

t_cp_outage() {
  step "cp-outage: control plane down; gateways keep serving the last snapshot"
  start_load cpout 20 5m
  sleep 30
  k scale deployment/stratum-control-plane --replicas=0 >/dev/null
  echo "    control plane scaled to 0 at $(date -u +%H:%M:%S)"
  sleep 60
  local victim; victim="$(gateway_pods | head -1)"
  k delete pod "$victim" --wait=false >/dev/null
  echo "    restarted $victim during the outage"
  sleep 90
  local ready; ready="$(ready_gateways)"
  echo "    ready gateways during outage: $ready (a pod started during the outage has no snapshot: known limitation, ADR-0003)"
  echo "    snapshot age (max over pods, s): $(metric stratum_snapshot_age_seconds)"
  k scale deployment/stratum-control-plane --replicas=2 >/dev/null
  k rollout status deployment/stratum-control-plane --timeout=10m >/dev/null
  judge_load "control plane outage" "$(load_result cpout)" 0
}

t_sql_failover() {
  step "sql-failover: Cloud SQL HA failover under load"
  if [[ "$(gcloud sql instances describe "$SQL_INSTANCE" --project "$PROJECT_ID" --format='value(settings.availabilityType)')" != REGIONAL ]]; then
    warn "Cloud SQL is zonal (cloudsql_ha = false): skipping"; return
  fi
  start_load sqlfo 20 5m
  sleep 45
  echo "    failover started at $(date -u +%H:%M:%S)"
  local t0; t0=$(date +%s)
  gcloud sql instances failover "$SQL_INSTANCE" --project "$PROJECT_ID" --quiet >/dev/null
  echo "    failover finished in $(( $(date +%s) - t0 ))s"
  judge_load "database failover (gateway unaffected)" "$(load_result sqlfo)" 0
  # The control plane is allowed to blip (99.9% target); measure it.
  port_forward svc/stratum-cp-sync 13001:80
  local c; c="$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $(sm_get sync-token)" \
    "http://127.0.0.1:13001/api/internal/sync?since_version=0")"
  cleanup_pf
  [[ "$c" == 200 ]] && pass "database failover: control plane serving again" || fail "database failover: sync endpoint returned $c"
}

case "${1:-all}" in
  smoke) t_smoke ;;
  quota) t_quota ;;
  quota-reset) t_quota_reset ;;
  rollout) t_rollout ;;
  zone) t_zone "${2:+hard}" ;;
  valkey) t_valkey ;;
  cp-outage) t_cp_outage ;;
  sql-failover) t_sql_failover ;;
  all)
    record "## Run $(date -u +%Y-%m-%dT%H:%MZ) — $HOST"
    t_smoke; t_quota_reset; t_quota; t_rollout; t_zone; t_valkey; t_cp_outage; t_sql_failover
    ;;
  *) die "unknown scenario $1" ;;
esac

echo
echo "  results: $RESULTS_DIR/$(date -u +%Y-%m-%d).md"
exit "$FAILED"
