#!/bin/sh
# Installs kubeconform from its GitHub release into DIR, checked against a
# pinned SHA-256. CI used `go install`, which also asks the Go module
# proxy and the checksum database about newer versions; a transient error
# there (sum.golang.org, HTTP/2 INTERNAL_ERROR) failed the job.
#
#   scripts/install-kubeconform.sh DIR
#
# To upgrade: change VERSION and SHA256 (the release's CHECKSUMS file,
# kubeconform-linux-amd64.tar.gz).
set -eu
VERSION=v0.6.7
SHA256=95f14e87aa28c09d5941f11bd024c1d02fdc0303ccaa23f61cef67bc92619d73

dest="${1:?usage: install-kubeconform.sh DIR}"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
curl -fsSL --retry 3 --retry-all-errors -o "$tmp/kubeconform.tar.gz" \
  "https://github.com/yannh/kubeconform/releases/download/${VERSION}/kubeconform-linux-amd64.tar.gz"
echo "${SHA256}  $tmp/kubeconform.tar.gz" | sha256sum -c - >/dev/null
tar -xzf "$tmp/kubeconform.tar.gz" -C "$tmp" kubeconform
mkdir -p "$dest"
install -m 0755 "$tmp/kubeconform" "$dest/kubeconform"
"$dest/kubeconform" -v
