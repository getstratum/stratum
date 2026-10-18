# syntax=docker/dockerfile:1.7
#
# Stratum gateway image: one static binary on distroless, running as non-root
# with a read-only root filesystem (only /var/lib/stratum is writable).
#
# Base images are pinned by tag and digest (scripts/pin-images.sh);
# Dependabot proposes new digests and versions.

FROM --platform=$BUILDPLATFORM golang:1.26-alpine@sha256:3082400e369fa24d5fc60bca20edab3f6d604e0c5a690ec66b295eff4dd87ade AS build
WORKDIR /src
COPY go.mod ./
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
