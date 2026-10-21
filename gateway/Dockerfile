# syntax=docker/dockerfile:1.7
#
# Stratum gateway image: one static binary on distroless, running as non-root
# with a read-only root filesystem (only /var/lib/stratum is writable).
#
# Base images are pinned by tag and digest (scripts/pin-images.sh);
# Dependabot proposes new digests and versions.

FROM --platform=$BUILDPLATFORM golang:1.26-alpine@sha256:9ce231b28998b32e116927c61aa5c406183061d4f3f2d61b292c88e7f6bdf7ca AS build
WORKDIR /src
COPY go.mod ./
# The image's Go must be at least go.mod's toolchain, the patch release with
# the standard library's security fixes. golang images build with their own
# Go (GOTOOLCHAIN=local), so a stale digest would otherwise ship a vulnerable
# binary without a word.
RUN want="$(sed -n 's/^toolchain go//p' go.mod)"; have="$(go env GOVERSION | sed 's/^go//')"; \
    awk -v have="$have" -v want="$want" 'BEGIN { split(have, h, "."); split(want, w, "."); \
      for (i = 1; i <= 3; i++) { if (h[i] + 0 > w[i] + 0) exit 0; if (h[i] + 0 < w[i] + 0) exit 1 } exit 0 }' || \
    { echo "the image has Go $have, go.mod needs $want: update the golang digest" >&2; exit 1; }
RUN go mod download
COPY . .

ARG TARGETOS
ARG TARGETARCH
ARG VERSION=dev
ARG COMMIT=unknown
# -trimpath and -buildid= make the binary reproducible for a given source tree.
RUN CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH \
    go build -trimpath -buildvcs=false \
      -ldflags="-s -w -buildid= -X main.version=${VERSION} -X main.commit=${COMMIT}" \
      -o /out/stratum-gateway ./cmd/stratum-gateway \
 && mkdir -p /out/state

FROM gcr.io/distroless/static-debian12:nonroot@sha256:afa5c872c891853ca7fcf1f12c3edb23f7eeef36189728842dd51042ff57f7ab
COPY --from=build /out/stratum-gateway /usr/local/bin/stratum-gateway
COPY --from=build --chown=65532:65532 /out/state /var/lib/stratum

USER 65532:65532
EXPOSE 20128 9090
VOLUME ["/var/lib/stratum"]
# distroless has no shell or curl; the binary probes itself.
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD ["/usr/local/bin/stratum-gateway", "healthcheck"]
ENTRYPOINT ["/usr/local/bin/stratum-gateway"]
