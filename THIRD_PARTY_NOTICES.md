# Third-party notices

## Gateway (`gateway/`)

The gateway is built from the Go standard library only. It has no third-party
Go module dependencies (see `gateway/go.mod`).

## Control plane (`control-plane/dashboard/`)

The control plane depends on the npm packages listed in
`control-plane/dashboard/package-lock.json`, each under its own license. A full
SBOM (SPDX) is attached to every container image release.

## Source code reused from other projects

None at this time. If code from another project is incorporated, its original
copyright and license notice will be reproduced here.
