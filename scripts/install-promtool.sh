#!/bin/sh
# Installs promtool (Prometheus' rule checker and test runner) from the
# Prometheus GitHub release into DIR, checked against a pinned SHA-256.
#
#   scripts/install-promtool.sh DIR
#
# To upgrade: change VERSION and SHA256 (the release's sha256sums.txt,
# prometheus-<version>.linux-amd64.tar.gz).
set -eu
VERSION=3.5.0
SHA256=e811827af26d822afb09a4f28314f61b618b12cff5369835a67f674d8b46f39a

dest="${1:?usage: install-promtool.sh DIR}"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
curl -fsSL --retry 3 --retry-all-errors -o "$tmp/prometheus.tar.gz" \
  "https://github.com/prometheus/prometheus/releases/download/v${VERSION}/prometheus-${VERSION}.linux-amd64.tar.gz"
echo "${SHA256}  $tmp/prometheus.tar.gz" | sha256sum -c - >/dev/null
tar -xzf "$tmp/prometheus.tar.gz" -C "$tmp" "prometheus-${VERSION}.linux-amd64/promtool"
mkdir -p "$dest"
install -m 0755 "$tmp/prometheus-${VERSION}.linux-amd64/promtool" "$dest/promtool"
"$dest/promtool" --version | head -1
