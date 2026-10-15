# GCP reference deployment of Stratum. Run from Cloud Shell (it has gcloud,
# terraform, kubectl, helm, jq and envsubst) or any machine with them.
#
#   make up        infrastructure (Terraform), ~20-25 min
#   make deploy    build images, deploy and wire everything, ~15-20 min
#   make test      full HA test plan, ~45 min
#   make down      delete everything
SHELL := /usr/bin/env bash
S := scripts

.PHONY: up deploy test down status keys console
up:
	@$(S)/up.sh

deploy:
	@$(S)/deploy.sh

test:
	@$(S)/test.sh all

test-%:
	@$(S)/test.sh $*

down:
	@$(S)/down.sh

status:
	@source $(S)/lib.sh && load_outputs && kube_credentials && \
	  kubectl -n $$NAMESPACE get gateway,httproute,pods,hpa,pdb -o wide && \
	  gcloud certificate-manager certificates describe $$CERTIFICATE_NAME --project $$PROJECT_ID --format='value(managed.state)'

keys:
	@source $(S)/lib.sh && load_outputs && \
	  echo "engineering: $$(sm_get key-engineering)" && \
	  echo "marketing:   $$(sm_get key-marketing)" && \
	  echo "console:     https://$$HOST  (dev@acme.com / $$(sm_get console-password))"
