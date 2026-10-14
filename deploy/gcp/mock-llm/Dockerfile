# syntax=docker/dockerfile:1.7
FROM golang:1.26-alpine AS build
WORKDIR /src
COPY go.mod main.go ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/mock-llm .

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/mock-llm /usr/local/bin/mock-llm
USER 65532:65532
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/mock-llm"]
