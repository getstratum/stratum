# syntax=docker/dockerfile:1.7
#
# Stratum gateway image: one static binary on distroless, running as non-root
# with a read-only root filesystem (only /var/lib/stratum is writable).
#
# Base images are referenced by tag here; Dependabot pins and bumps them.

ARG GO_VERSION=1.26

FROM --platform=$BUILDPLATFORM golang:${GO_VERSION}-alpine AS build
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

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/stratum-gateway /usr/local/bin/stratum-gateway
COPY --from=build --chown=65532:65532 /out/state /var/lib/stratum

USER 65532:65532
EXPOSE 20128 9090
VOLUME ["/var/lib/stratum"]
# distroless has no shell or curl; the binary probes itself.
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD ["/usr/local/bin/stratum-gateway", "healthcheck"]
ENTRYPOINT ["/usr/local/bin/stratum-gateway"]
