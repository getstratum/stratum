# shellcheck shell=bash
# Shared helpers for the GCP test environment scripts. Sourced, not run.
set -euo pipefail

GCP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck disable=SC2034 # used by the scripts that source this file
REPO_ROOT="$(cd "$GCP_DIR/../.." && pwd)"
TF_DIR="$GCP_DIR/terraform"
RESULTS_DIR="$GCP_DIR/.results"
TF="${TF:-terraform}"

# Third-party images. Override to pin by digest in your own runs.
PROXY_IMAGE="${PROXY_IMAGE:-gcr.io/cloud-sql-connectors/cloud-sql-proxy:2.14.1}"
PSQL_IMAGE="${PSQL_IMAGE:-postgres:16-alpine}"
K6_IMAGE="${K6_IMAGE:-grafana/k6:1.0.0}"
VALKEY_CLI_IMAGE="${VALKEY_CLI_IMAGE:-valkey/valkey:8.1-alpine}"

c_blue=$'\033[34m'; c_green=$'\033[32m'; c_yellow=$'\033[33m'; c_red=$'\033[31m'; c_off=$'\033[0m'
step() { printf '\n%s==> %s%s\n' "$c_blue" "$*" "$c_off"; }
ok()   { printf '%s  ok%s %s\n' "$c_green" "$c_off" "$*"; }
warn() { printf '%s  warning:%s %s\n' "$c_yellow" "$c_off" "$*" >&2; }
die()  { printf '%s  error:%s %s\n' "$c_red" "$c_off" "$*" >&2; exit 1; }

require() {
  local missing=()
  for t in "$@"; do command -v "$t" >/dev/null 2>&1 || missing+=("$t"); done
  ((${#missing[@]} == 0)) || die "missing tools: ${missing[*]} (Cloud Shell has all of them)"
}

# Cloud Shell no longer ships Terraform: `terraform` there is a placeholder
# that prints install instructions and exits 0, so checking that the command
# exists is not enough. Ask for the version as JSON instead (OpenTofu
# answers the same way, so TF=tofu works too).
TF_MIN_VERSION=1.6.0
require_terraform() {
  local v
  v="$("$TF" version -json 2>/dev/null | jq -r '.terraform_version // empty' 2>/dev/null || true)"
  [[ -n "$v" ]] || die "'$TF' is not a working Terraform. Install Terraform >= $TF_MIN_VERSION (README: \"Before you start\") or run with TF=tofu."
  printf '%s\n%s\n' "$TF_MIN_VERSION" "$v" | sort -V -C ||
    die "Terraform $v is too old; this kit needs >= $TF_MIN_VERSION"
}

# Reads every Terraform output into an upper-case shell variable
# (host -> HOST, sql_connection_name -> SQL_CONNECTION_NAME, ...).
load_outputs() {
  require_terraform
  [[ -f "$TF_DIR/terraform.tfstate" || -d "$TF_DIR/.terraform" ]] || die "no Terraform state: run 'make up' first"
  local json
  json="$("$TF" -chdir="$TF_DIR" output -json)" || die "cannot read Terraform outputs"
  [[ "$json" != "{}" || -n "${ALLOW_EMPTY_OUTPUTS:-}" ]] || die "Terraform state has no outputs: run 'make up' first"
  while IFS=$'\t' read -r k v; do
    printf -v "${k^^}" '%s' "$v"
    export "${k^^}"
  done < <(jq -r 'to_entries[] | [.key, (.value.value | tostring)] | @tsv' <<<"$json")
  export NAMESPACE PROJECT_ID REGION HOST
}

kube_credentials() {
  gcloud container clusters get-credentials "$CLUSTER_NAME" \
    --region "$REGION" --project "$PROJECT_ID" --dns-endpoint >/dev/null
  kubectl version --request-timeout=20s >/dev/null || die "cannot reach the cluster API"
}

k() { kubectl -n "$NAMESPACE" "$@"; }

# render FILE: substitutes only ${VARS} listed here, so other "$" survive.
RENDER_VARS='${NAMESPACE} ${HOST} ${CERT_MAP} ${EDGE_IP_NAME} ${SSL_POLICY} ${ARMOR_API} ${ARMOR_CONSOLE} ${ARMOR_SYNC} ${CP_IMAGE} ${MOCK_IMAGE} ${PROXY_IMAGE} ${PSQL_IMAGE} ${K6_IMAGE} ${SQL_CONNECTION_NAME} ${SQL_DATABASE} ${JOB_NAME} ${SQL_COMMAND} ${SQL_CONFIGMAP} ${RATE} ${DURATION} ${VALKEY_IP}'
render() {
  export CERT_MAP="${CERTIFICATE_MAP:-}" ARMOR_API="${ARMOR_API_POLICY:-}" \
    ARMOR_CONSOLE="${ARMOR_CONSOLE_POLICY:-}" ARMOR_SYNC="${ARMOR_SYNC_POLICY:-}" \
    PROXY_IMAGE PSQL_IMAGE K6_IMAGE
  envsubst "$RENDER_VARS" <"$1"
}

# ── Secret Manager ──────────────────────────────────────────────────────────

sm_name() { echo "${SECRET_PREFIX}-$1"; }

sm_get() {
  gcloud secrets versions access latest --secret "$(sm_name "$1")" --project "$PROJECT_ID" 2>/dev/null
}

sm_put() { # name value
  local n; n="$(sm_name "$1")"
  if ! gcloud secrets describe "$n" --project "$PROJECT_ID" >/dev/null 2>&1; then
    gcloud secrets create "$n" --project "$PROJECT_ID" --replication-policy automatic \
      --labels "app=stratum,env=${SECRET_PREFIX#stratum-}" >/dev/null
  fi
  printf '%s' "$2" | gcloud secrets versions add "$n" --project "$PROJECT_ID" --data-file=- >/dev/null
}

# sm_ensure NAME COMMAND...: value from Secret Manager, generated once.
sm_ensure() {
  local name="$1"; shift
  local v
  if v="$(sm_get "$name")" && [[ -n "$v" ]]; then
    printf '%s' "$v"
    return
  fi
  v="$("$@")"
  sm_put "$name" "$v"
  printf '%s' "$v"
}

hex32() { openssl rand -hex 32; }
b64_24() { openssl rand -base64 24 | tr -d '/+=' ; }
b32_20() { openssl rand 20 | base32 | tr -d '=\n'; } # authenticator secret (160 bits)

# totp_code SECRET [STEP_OFFSET]: the current 6-digit code (RFC 6238), as an
# authenticator app shows it. The console accepts each code once, so a
# second sign-in within 30 s passes 1 to use the next step's code.
totp_code() {
  python3 - "$1" "${2:-0}" <<'PY'
import base64, hashlib, hmac, struct, sys, time
secret, offset = sys.argv[1], int(sys.argv[2])
key = base64.b32decode(secret + "=" * (-len(secret) % 8))
mac = hmac.new(key, struct.pack(">Q", int(time.time()) // 30 + offset), hashlib.sha1).digest()
o = mac[-1] & 15
print("%06d" % ((struct.unpack(">I", mac[o:o + 4])[0] & 0x7FFFFFFF) % 1000000))
PY
}

# Creates or updates a Kubernetes secret from KEY=VALUE pairs. Values go
# through a private temp file, not through command-line arguments.
kube_secret() { # name key=value...
  local name="$1"; shift
  local f; f="$(mktemp)"; chmod 600 "$f"
  printf '%s\n' "$@" >"$f"
  k create secret generic "$name" --from-env-file="$f" --dry-run=client -o yaml | k apply -f - >/dev/null
  rm -f "$f"
}

# ── Jobs ────────────────────────────────────────────────────────────────────

# run_sql_job NAME CONFIGMAP JSON_COMMAND
run_sql_job() {
  export JOB_NAME="$1" SQL_CONFIGMAP="$2" SQL_COMMAND="$3"
  k delete job "$JOB_NAME" --ignore-not-found --wait=true >/dev/null
  render "$GCP_DIR/k8s/sql-job.yaml" | k apply -f - >/dev/null
  wait_job "$JOB_NAME" 600
  k logs "job/$JOB_NAME" -c psql | sed 's/^/    /'
}

# wait_job NAME TIMEOUT_SECONDS: returns 0 on success, 1 on failure.
wait_job() {
  local name="$1" timeout="$2" t=0 s f
  while ((t < timeout)); do
    s="$(k get job "$name" -o jsonpath='{.status.succeeded}' 2>/dev/null || true)"
    f="$(k get job "$name" -o jsonpath='{.status.failed}' 2>/dev/null || true)"
    [[ "${s:-0}" -ge 1 ]] && return 0
    if [[ "${f:-0}" -ge 1 ]]; then
      warn "job $name failed"
      k logs "job/$name" --all-containers --tail=50 2>/dev/null | sed 's/^/    /' >&2 || true
      return 1
    fi
    sleep 5; t=$((t + 5))
  done
  die "job $name did not finish in ${timeout}s"
}

# ── Port-forward ────────────────────────────────────────────────────────────

PF_PIDS=()
cleanup_pf() { for p in "${PF_PIDS[@]:-}"; do [[ -n "$p" ]] && kill "$p" 2>/dev/null || true; done; }
trap cleanup_pf EXIT

# port_forward TARGET LOCAL:REMOTE: background kubectl port-forward, waits until open.
port_forward() {
  local target="$1" ports="$2" lport="${2%%:*}"
  k port-forward "$target" "$ports" >/dev/null 2>&1 &
  PF_PIDS+=("$!")
  for _ in $(seq 1 30); do
    (exec 3<>"/dev/tcp/127.0.0.1/$lport") 2>/dev/null && return 0
    sleep 1
  done
  die "port-forward to $target did not open"
}

record() { # append a line to today's results file
  mkdir -p "$RESULTS_DIR"
  printf '%s\n' "$*" >>"$RESULTS_DIR/$(date -u +%Y-%m-%d).md"
}
