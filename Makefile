VERSION ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo dev)
COMMIT  ?= $(shell git rev-parse HEAD 2>/dev/null || echo unknown)
LDFLAGS := -s -w -buildid= -X main.version=$(VERSION) -X main.commit=$(COMMIT)
COMPOSE := docker compose -f deploy/compose/docker-compose.yml --env-file deploy/compose/.env

.PHONY: test lint contract build image up down

test:
	cd gateway && go test -race -count=1 ./...

lint:
	cd gateway && test -z "$$(gofmt -l .)" || (gofmt -l . && exit 1)
	cd gateway && go vet ./...
	cd gateway && go run honnef.co/go/tools/cmd/staticcheck@2025.1.1 ./...

contract:
	check-jsonschema --check-metaschema api/sync/v2/sync-response.schema.json
	check-jsonschema --schemafile api/sync/v2/sync-response.schema.json api/sync/v2/examples/*.json

build:
	cd gateway && CGO_ENABLED=0 go build -trimpath -buildvcs=false -ldflags "$(LDFLAGS)" -o ../bin/stratum-gateway ./cmd/stratum-gateway

image:
	docker build -t stratum-gateway:dev --build-arg VERSION=$(VERSION) --build-arg COMMIT=$(COMMIT) gateway
	docker build -t stratum-control-plane:dev control-plane/dashboard

up:
	$(COMPOSE) up -d --build

down:
	$(COMPOSE) down
