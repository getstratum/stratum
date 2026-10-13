# Security policy

## Reporting a vulnerability

Please **do not open a public issue** for security problems.

Report privately through GitHub: *Security* tab → *Report a vulnerability*
(private vulnerability reporting). Include what you found, how to reproduce it
and the version or commit affected.

We aim to acknowledge reports within 3 business days and to agree on a fix and
disclosure timeline within 10 business days. We credit reporters in the
advisory unless they prefer otherwise.

## Supported versions

Until 1.0, only the latest minor release receives security fixes.

## What we consider in scope

- Bypassing authentication, team policy, quotas or PII/DLP controls in the gateway
- Leaking provider credentials (in transit, on disk, in logs or metrics)
- Prompt or response content appearing in logs, metrics or the control plane
- Authentication and authorization flaws in the control plane
- Supply-chain issues in our build and release pipeline

## Release integrity

Container images are signed with Sigstore cosign (keyless) and carry SLSA
build provenance and an SBOM. Verify an image with:

```sh
cosign verify ghcr.io/getstratum/stratum-gateway:<version> \
  --certificate-identity-regexp '^https://github.com/getstratum/stratum/' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```
