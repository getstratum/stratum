# syntax=docker/dockerfile:1.7
# Stratum control plane migrations: migrate.sh and the SQL files, with psql.
# Runs once per control plane pod start (Helm chart init container) or as a
# Job; each file is applied once, under an advisory lock (see migrate.sh).
#
#   docker run --rm -e DATABASE_URL=postgresql://... ghcr.io/getstratum/stratum-migrations
FROM postgres:16-alpine@sha256:f2f98726820d0342055351c6e9d36e705f5bfffb3dd53ff556325114b08afb6d
# Plain COPY: with --chmod, BuildKit gave the directory it created the
# files' mode too (0444, no search bit), and uid 70 could not open them.
COPY *.sql migrate.sh /migrations/
# uid 70: the postgres user of the alpine image. psql only needs /tmp.
USER 70:70
ENTRYPOINT ["sh", "/migrations/migrate.sh", "/migrations"]
