#!/usr/bin/env bash
# Test plan for the HA claims. Each scenario prints a verdict and appends it
# to deploy/gcp/.results/<date>.md.
#
#   ./test.sh all | smoke | warmup | quota | quota-reset | rollout | zone [--hard]
#             | valkey | cp-outage | sql-failover | console
#
# console is not part of all: it needs Node.js and installs Playwright with
# Chromium (control-plane/e2e).
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

# metric NAME: value of a gauge/counter summed over every running gateway
# pod (pods being deleted are skipped). Each pod is read through its own
# port-forward, on a port not used before in this run, with retries. If any
# pod cannot be read it prints nothing and returns 1: a read that failed must
# never count as 0 (the 2026-10-16 run reported two false failures that way).
metric() {
  local total=0 p port v pf
  for p in $(k get pods -l app.kubernetes.io/name=stratum-gateway -o json |
             jq -r '.items[] | select(.metadata.deletionTimestamp == null and .status.phase == "Running") | .metadata.name'); do
    port=$((20000 + RANDOM % 20000))
    k port-forward "pod/$p" "$port:9090" >/dev/null 2>&1 &
    pf=$!
    v=""
    for _ in $(seq 1 15); do
      v="$(curl -sf -m 3 "http://127.0.0.1:$port/metrics" 2>/dev/null | awk -v m="$1" '$1==m {print $2}')"
      [[ -n "$v" ]] && break
      sleep 1
    done
    kill "$pf" 2>/dev/null; wait "$pf" 2>/dev/null
    if [[ ! "$v" =~ ^[0-9]+$ ]]; then
      warn "could not read $1 from $p"
      return 1
    fi
    total=$((total + v))
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
  # Keep the whole log with the results: the job is gone after 'make down'.
  mkdir -p "$RESULTS_DIR"
  k logs "job/$name" >"$RESULTS_DIR/$(date -u +%Y-%m-%d)-$name.log" 2>&1 || true
  sed -n 's/^K6_RESULT //p' "$RESULTS_DIR/$(date -u +%Y-%m-%d)-$name.log" | tail -1
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
    echo "    failures (first 100, UTC, with the response body): grep K6_FAILURE $RESULTS_DIR/$(date -u +%Y-%m-%d)-$JOB_NAME.log"
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
  echo "    pending tokens (all replicas): $(metric stratum_quota_pending_tokens || echo '?')  flush failures: $(metric stratum_quota_store_flush_failure_total || echo '?')"
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

# A new load balancer can answer a share of requests with 500 for several
# minutes after it first serves: 500s of 66 bytes, about 3 ms, no
# statusDetails, never seen by a gateway. In both real runs the first load
# after the deploy had them (27 on 2026-10-14, 79 on 2026-10-16) and later
# loads had none or one. Warm-up loads the edge in 2-minute rounds until one
# is clean, so the scenarios after it measure Stratum and not the edge
# settling; each round is recorded, which also measures how long that takes.
t_warmup() {
  step "warmup: load the new edge until a round has no path errors"
  local round r reqs path
  for round in 1 2 3 4 5 6; do
    start_load "warmup-$round" 20 2m
    r="$(load_result "warmup-$round")"
    if [[ -z "$r" ]]; then warn "warmup round $round: no k6 result"; continue; fi
    reqs="$(jq -r .requests <<<"$r")"
    path="$(jq -r '.edge_errors + .network_errors' <<<"$r")"
    echo "    round $round (from $LOAD_START): $path path errors of $reqs"
    record "- note $(date -u +%H:%M) warmup round $round (from $LOAD_START): path errors $path of $reqs"
    if ((path == 0)); then
      pass "warmup: edge answered cleanly in round $round"
      return
    fi
    edge_breakdown
  done
  fail "warmup: edge still failing after 6 rounds (12 min); path results below are not about Stratum"
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
  local before failures pending blocked
  before="$(metric stratum_quota_store_flush_failure_total)" || before=""
  start_load valkey 20 4m
  sleep 30
  kubectl apply -f - <<<"$np" >/dev/null
  blocked=$(date +%s)
  echo "    Valkey blocked at $(date -u +%H:%M:%S)"
  sleep 75
  failures="$(metric stratum_quota_store_flush_failure_total)" || failures=""
  pending="$(metric stratum_quota_pending_tokens)" || pending=""
  k delete networkpolicy chaos-block-valkey >/dev/null
  echo "    Valkey restored at $(date -u +%H:%M:%S) ($(( $(date +%s) - blocked )) s blocked)"
  if [[ -n "$before" && -n "$failures" ]]; then
    echo "    during outage: flush failures +$((failures - before)), pending tokens ${pending:-?}"
  fi
  judge_load "valkey outage: requests unaffected" "$(load_result valkey)" 0
  sleep 10
  if [[ -z "$before" || -z "$failures" ]]; then
    fail "valkey outage: could not read the gateways' metrics, outage detection not measured"
  elif ((failures > before)); then
    pass "valkey outage: detected (flush failures increased)"
  else
    fail "valkey outage: no flush failures recorded"
  fi
  pending="$(metric stratum_quota_pending_tokens)" || pending=""
  if [[ -z "$pending" ]]; then
    fail "valkey outage: could not read the gateways' metrics, backlog not measured"
  elif ((pending == 0)); then
    pass "valkey outage: backlog reconciled (0 pending tokens)"
  else
    fail "valkey outage: $pending tokens still pending"
  fi
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
  # The replacement pod has no snapshot of its own; it must start from the
  # copy the gateways keep in Valkey (ADR-0008).
  local ready total bootstraps
  ready="$(ready_gateways)"
  total="$(k get pods -l app.kubernetes.io/name=stratum-gateway -o json | jq '[.items[] | select(.metadata.deletionTimestamp == null)] | length')"
  bootstraps="$(metric stratum_snapshot_shared_bootstraps_total)" || bootstraps=""
  echo "    ready gateways during outage: $ready of $total; started from the snapshot in Valkey: ${bootstraps:-could not read}"
  if [[ -z "$bootstraps" ]]; then
    fail "control plane outage: $ready of $total gateways ready; could not read the gateways' metrics to confirm the start from Valkey"
  elif ((ready == total && bootstraps >= 1)); then
    pass "control plane outage: the replacement pod started from the snapshot in Valkey and is serving"
  else
    fail "control plane outage: $ready of $total gateways ready, $bootstraps started from Valkey (expected all ready, at least 1)"
  fi
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

# Functional test of the console in a real browser (control-plane/e2e):
# sign-in, roles, providers, gateways, agents (a new key through the public
# gateway, then revoked), people, my account, audit log. It reaches the console
# through a port-forward, so it runs from any IP; the gateway through the edge.
t_console() {
  step "console: functional test in a browser"
  require node npm
  local dir; dir="$(cd "$GCP_DIR/../../control-plane/e2e" && pwd)"
  (cd "$dir" && npm ci --no-audit --no-fund >/dev/null) || { fail "console: npm ci failed in $dir"; return; }
  # --with-deps installs the system libraries Chromium needs (sudo; fine in
  # Cloud Shell). Elsewhere they may already be there.
  (cd "$dir" && { npx playwright install --with-deps chromium >/dev/null 2>&1 || npx playwright install chromium >/dev/null; }) ||
    { fail "console: could not install Chromium for Playwright"; return; }
  port_forward svc/stratum-cp-console 13000:80
  if (cd "$dir" &&
      STRATUM_E2E_CONSOLE_URL=http://localhost:13000 \
      STRATUM_E2E_GATEWAY_URL="https://$HOST" \
      STRATUM_E2E_EMAIL=dev@acme.com \
      STRATUM_E2E_PASSWORD="$(sm_get console-password)" \
      STRATUM_E2E_TOTP_SECRET="$(sm_get console-totp)" \
      npx playwright test); then
    pass "console: functional test (report: control-plane/e2e/report/index.html)"
  else
    fail "console: functional test, see control-plane/e2e/report/index.html"
  fi
  cleanup_pf
}

case "${1:-all}" in
  smoke) t_smoke ;;
  warmup) t_warmup ;;
  quota) t_quota ;;
  quota-reset) t_quota_reset ;;
  rollout) t_rollout ;;
  zone) t_zone "${2:+hard}" ;;
  valkey) t_valkey ;;
  cp-outage) t_cp_outage ;;
  sql-failover) t_sql_failover ;;
  console) t_console ;;
  all)
    record "## Run $(date -u +%Y-%m-%dT%H:%MZ) — $HOST"
    t_smoke; t_warmup; t_quota_reset; t_quota; t_rollout; t_zone; t_valkey; t_cp_outage; t_sql_failover
    ;;
  *) die "unknown scenario $1" ;;
esac

echo
echo "  results: $RESULTS_DIR/$(date -u +%Y-%m-%d).md"
exit "$FAILED"
