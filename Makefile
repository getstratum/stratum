VERSION ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo dev)
COMMIT  ?= $(shell git rev-parse HEAD 2>/dev/null || echo unknown)
LDFLAGS := -s -w -buildid= -X main.version=$(VERSION) -X main.commit=$(COMMIT)
COMPOSE := docker compose -f deploy/compose/docker-compose.yml --env-file deploy/compose/.env

DEMO    := docker compose -f deploy/demo/docker-compose.yml

.PHONY: test lint contract build image up down demo demo-down

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

# Stratum in one command, with a mock LLM and demo data (deploy/demo). DEMO ONLY.
demo:
	$(DEMO) up -d --build --wait control-plane mock-llm
	$(DEMO) up --build --exit-code-from setup setup
	$(DEMO) up -d --build gateway
	$(DEMO) up --exit-code-from traffic traffic
	@echo "Console: http://localhost:3000 (accounts above). Stop and delete everything: make demo-down"

demo-down:
	$(DEMO) down -v
