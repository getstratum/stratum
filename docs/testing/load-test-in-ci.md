# Load test in CI: design

The release checklist asks for "a rolling deploy under constant load with
zero errors, streams included" in CI. Today that claim is proven on GCP by
hand (`deploy/gcp`, `make test`: three real runs, the last one with 0 errors
from Stratum in 52,805 requests), which costs a few dollars and an afternoon
per run. This is how to get the same check on every release candidate,
for free, on a GitHub runner. Not implemented yet: the runner has to pull
images and start a cluster, which cannot be tried from where this was
written.

## What it proves

While k6 sends a constant rate through the gateways, 70 % unary and 30 %
streamed requests:

1. a rolling upgrade of the gateway release (`helm upgrade` with a changed
   pod annotation) loses nothing: no 5xx from the gateway and no stream cut
   before `[DONE]`;
2. a rolling upgrade of the control plane release loses nothing either
   (gateways do not depend on it to serve);
3. scaling the control plane to 0 for a minute changes nothing on the
   request path.

Verdict: `gateway_5xx == 0` and `broken_streams == 0`, using the attribution
`deploy/gcp/loadtest/k6.js` already does (the gateway sets
`X-Stratum-Request-Id` on everything it answers). There is no edge here, so
every failure is either the gateway's or the runner's.

## Shape

A workflow `load.yml`, separate from `ci.yml` (it takes about 12 minutes):

- **When:** on pull requests from release-please (the release candidate),
  nightly on `main`, and by hand. Not on every pull request.
- **Cluster:** kind, one node, on `ubuntu-latest` (4 vCPU, 16 GB). The
  gateway's zone spread is set to `ScheduleAnyway`; three replicas on one
  node still exercise the drain and the PodDisruptionBudget.
- **Images:** built in the job from the commit (`docker build`, loaded with
  `kind load docker-image`): gateway, control plane, migrations, mock LLM.
  The same Dockerfiles as the release.
- **Database:** PostgreSQL 16 as a plain Deployment with an emptyDir, and
  the control plane chart with its migrations image (the chart has been
  installed this way on Docker Desktop's Kubernetes).
- **Bootstrap:** `control-plane/seed/demo.sql`, an owner with a second factor
  (`stratum-admin create-owner` and `enroll-mfa`), a gateway registration and
  the mock as the `ollama` provider, through the console API, the way
  `control-plane/e2e/run-local.sh` does.
- **Load:** the k6 image as a Job inside the cluster, `deploy/gcp/loadtest/k6.js`
  against the gateway Service, 50 requests per second, with the mock's
  latency (`MOCK_LATENCY_MS`, `MOCK_CHUNK_INTERVAL_MS`) so that streams are
  in flight during the upgrade.
- **Disruptions,** each in its own window while k6 runs:
  `helm upgrade` of the gateway; `helm upgrade` of the control plane;
  `kubectl scale --replicas=0` of the control plane for 60 s.
- **Result:** the k6 summary as a job artifact, the gateway logs of the
  failures (`K6_FAILURE` lines carry the request ID), and the verdict as the
  job's status.

## Costs and risks

- About 12 minutes of runner time per run: building four images (cached
  with `type=gha`), starting kind, three disruptions of two to three
  minutes each.
- A single node shares CPU among the load generator, the gateways, the
  mock and PostgreSQL. 50 requests per second leaves room on 4 vCPU; the
  local test on 1 CPU showed probes timing out (fixed in the chart's
  timeouts), so the rate is a parameter, not a constant.
- Flakiness has to be zero for the check to mean something: the first runs
  go nightly only, and the job blocks releases once it has been clean for
  two weeks.

## Steps to implement

1. `deploy/kind/` with the kind config, the PostgreSQL manifest and values
   for both charts (single node, small requests).
2. `scripts/load-test.sh`: cluster, images, install, bootstrap, the three
   disruptions with k6 running, verdict. Runnable on a laptop with Docker.
3. `.github/workflows/load.yml` calling it, with the triggers above.
4. Tick the checklist item after two clean weeks.
