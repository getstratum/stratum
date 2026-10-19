# syntax=docker/dockerfile:1.7
# Stratum control plane migrations: migrate.sh and the SQL files, with psql.
# Runs once per control plane pod start (Helm chart init container) or as a
# Job; each file is applied once, under an advisory lock (see migrate.sh).
#
#   docker run --rm -e DATABASE_URL=postgresql://... ghcr.io/getstratum/stratum-migrations
FROM postgres:16-alpine@sha256:721873c34ceb9f8d8fc265984940dc982404c105f19ad51be9fdc5970a6080ea
COPY --chmod=0444 *.sql /migrations/
COPY --chmod=0555 migrate.sh /migrations/
# uid 70: the postgres user of the alpine image. psql only needs /tmp.
USER 70:70
ENTRYPOINT ["sh", "/migrations/migrate.sh", "/migrations"]
