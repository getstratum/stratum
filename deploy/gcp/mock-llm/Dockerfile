# syntax=docker/dockerfile:1.7
FROM golang:1.26-alpine@sha256:9ce231b28998b32e116927c61aa5c406183061d4f3f2d61b292c88e7f6bdf7ca AS build
WORKDIR /src
COPY go.mod main.go ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/mock-llm .

FROM gcr.io/distroless/static-debian12:nonroot@sha256:afa5c872c891853ca7fcf1f12c3edb23f7eeef36189728842dd51042ff57f7ab
COPY --from=build /out/mock-llm /usr/local/bin/mock-llm
USER 65532:65532
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/mock-llm"]
