#!/usr/bin/env bash
# Deletes everything the test environment created, in the order that leaves
# nothing billing behind:
#   1. Kubernetes resources, so the GKE controllers delete the load balancer
#      and network endpoint groups they created (Terraform does not know them)
#   2. Terraform-managed infrastructure
#   3. Secret Manager secrets created by deploy.sh
# Works after a partial 'make up' too: whatever exists is removed.
#
#   ./down.sh        asks for confirmation
#   ./down.sh -y     does not
# shellcheck source-path=SCRIPTDIR source=lib.sh
source "$(dirname "$0")/lib.sh"
require gcloud "$TF" kubectl helm jq

TFVARS="$TF_DIR/terraform.tfvars"
[[ -f "$TFVARS" ]] || die "no terraform/terraform.tfvars: nothing was created from this checkout"
tfvar() { sed -n "s/^$1 *= *\"\(.*\)\"/\1/p" "$TFVARS"; }
PROJECT_ID="$(tfvar project_id)"
REGION="$(tfvar region)"
ENV_NAME="$(tfvar env)"; ENV_NAME="${ENV_NAME:-test}"
CLUSTER_NAME="stratum-$ENV_NAME"
SECRET_PREFIX="stratum-$ENV_NAME"
NAMESPACE=stratum
if [[ -f "$TF_DIR/terraform.tfstate" ]]; then ALLOW_EMPTY_OUTPUTS=1 load_outputs; fi

if [[ "${1:-}" != "-y" ]]; then
  read -r -p "  Delete the Stratum '$CLUSTER_NAME' environment in $PROJECT_ID? Type the project id to confirm: " a
  [[ "$a" == "$PROJECT_ID" ]] || die "aborted"
fi

step "Kubernetes resources (load balancer, NEGs)"
if gcloud container clusters describe "$CLUSTER_NAME" --region "$REGION" --project "$PROJECT_ID" >/dev/null 2>&1; then
  if kube_credentials 2>/dev/null; then
    helm uninstall stratum-gateway -n "$NAMESPACE" --wait >/dev/null 2>&1 || true
    kubectl delete namespace "$NAMESPACE" --wait=true --timeout=15m >/dev/null 2>&1 || warn "namespace deletion timed out"
    # The Gateway controller removes the load balancer asynchronously.
    for _ in $(seq 1 40); do
      left="$(gcloud compute forwarding-rules list --global --project "$PROJECT_ID" \
        --filter="name~stratum-edge" --format='value(name)' 2>/dev/null | wc -l)"
      [[ "$left" == 0 ]] && break
      sleep 15
    done
    ok "load balancer removed"
  else
    warn "cluster exists but is not reachable; continuing"
  fi
else
  ok "no cluster"
fi

step "Terraform destroy"
rc=0
destroy() { "$TF" -chdir="$TF_DIR" destroy -input=false -auto-approve; }
"$TF" -chdir="$TF_DIR" init -input=false >/dev/null
if ! destroy; then
  warn "destroy failed; removing leftover GKE network endpoint groups and firewall rules, then retrying"
  gcloud compute network-endpoint-groups list --project "$PROJECT_ID" \
    --filter="network~/${CLUSTER_NAME}\$" --format='value(name,zone.basename())' 2>/dev/null |
    while read -r name zone; do
      gcloud compute network-endpoint-groups delete "$name" --zone "$zone" --project "$PROJECT_ID" --quiet || true
    done
  gcloud compute firewall-rules list --project "$PROJECT_ID" --filter="network~/${CLUSTER_NAME}\$" \
    --format='value(name)' 2>/dev/null | xargs -r gcloud compute firewall-rules delete --project "$PROJECT_ID" --quiet || true
  destroy || rc=1
fi

step "Secret Manager"
gcloud secrets list --project "$PROJECT_ID" --filter="name~/secrets/${SECRET_PREFIX}-" --format='value(name)' |
  xargs -r -n1 gcloud secrets delete --project "$PROJECT_ID" --quiet || rc=1

if ((rc == 0)); then
  # Cloud SQL and Memorystore names stay reserved for days after deletion:
  # the next 'make up' gets fresh ones.
  sed -i "s/^suffix *= *\".*\"/suffix                = \"$(openssl rand -hex 3)\"/" "$TFVARS"
fi

step "Leftovers check"
gcloud compute forwarding-rules list --project "$PROJECT_ID" --format='value(name)' | sed 's/^/  forwarding rule still present: /'
gcloud sql instances list --project "$PROJECT_ID" --format='value(name)' | sed 's/^/  Cloud SQL instance still present: /'
gcloud memorystore instances list --location "$REGION" --project "$PROJECT_ID" --format='value(name)' 2>/dev/null | sed 's/^/  Memorystore instance still present: /'
gcloud container clusters list --project "$PROJECT_ID" --format='value(name)' | sed 's/^/  GKE cluster still present: /'
if ((rc == 0)); then
  ok "done. If this project only held the test environment: gcloud projects delete $PROJECT_ID"
else
  die "some resources could not be deleted (see above). Deleting the project removes everything: gcloud projects delete $PROJECT_ID"
fi
