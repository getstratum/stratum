# Contributing to Stratum

Thanks for helping. A few rules keep the project healthy.

## Ground rules

- **The data plane must stay statically stable.** Nothing in the gateway's
  request path may depend on the control plane, a database, Redis or telemetry.
  If your change adds a network call to the hot path other than the call to the
  LLM provider, it needs an ADR first.
- **No new gateway dependencies without discussion.** The gateway is standard
  library only (ADR-0001). Open an issue before adding a module.
- **Never log prompt or response content.** Not in debug mode either.
- **Changing the sync contract** (`api/sync/`) means updating the schema, the
  examples and both sides, and respecting N/N-1 compatibility (ADR-0003).

## Workflow

1. Open an issue for anything bigger than a small fix.
2. Branch from `main`; keep PRs focused.
3. PR titles follow [Conventional Commits](https://www.conventionalcommits.org/)
   (`feat(gateway): ...`, `fix(control-plane): ...`). They drive the changelog.
4. Sign off your commits (`git commit -s`) to certify the
   [Developer Certificate of Origin](https://developercertificate.org/).
5. CI must be green: formatting, vet, static analysis, race-enabled tests,
   vulnerability scan, contract validation and image builds.

## Local development

```sh
make test        # gateway tests with the race detector
make lint        # gofmt, go vet, staticcheck
make contract    # validate sync contract examples
make build       # gateway binary in ./bin
make up          # local stack with Docker Compose
```

## Architecture decisions

Significant decisions are recorded in `docs/adr/`. Copy `0000-template.md`,
take the next number and open it as part of your PR.
