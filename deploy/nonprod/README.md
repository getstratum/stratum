# Stratum for non-production, with Docker Compose

One machine running Stratum for functional tests, policy validation and
training: the released images, secrets of its own, HTTPS, a daily backup.
Not highly available: if the machine stops, Stratum stops. For production,
the [chart](../helm/stratum) with `values-prod.yaml`.

| | |
|---|---|
| Console | `https://<console host>` |
| Gateways' API | `https://<gateway host>/v1`, two gateways behind Caddy |
| PostgreSQL 16 | one, with its data in a Docker volume |
| Valkey | shared quotas and the gateways' snapshot copy |
| Backup | a `pg_dump` every day at 03:17 UTC in `./backups`, kept 7 days |

Needs Stratum 1.0 or later (the `bootstrap` command) and Docker with
Compose 2.20+. About 2 CPUs and 4 GB.

## Install

Two names that point at the machine (DNS), and ports 80 and 443 open to
the internet for Let's Encrypt; on a private network, `STRATUM_TLS="tls
internal"` in `.env` (Caddy's own CA: install its root, `docker compose
exec caddy cat /data/caddy/pki/authorities/local/root.crt`, on the clients).

```sh
./init.sh consola.test.example.com gateway.test.example.com "Acme (pruebas)" ana@acme.com
docker compose up -d --wait
docker compose logs bootstrap
```

`init.sh` writes `.env` with this installation's secrets, once. **Keep a
copy of `.env`**: `STRATUM_ENCRYPTION_KEY` reads the providers' keys and
everyone's second factor, and without it they are lost.

The `bootstrap` service creates the organization, its Owner (the password
is in its log, shown once: change it at the first sign-in) and registers
the gateways. It runs on every `up` and changes nothing once all is there.

Then, in the console: providers and their keys, teams and policies, people.
Applications call `https://<gateway host>/v1` with the keys the console
gives.

## Upgrade

```sh
sed -i 's/^STRATUM_VERSION=.*/STRATUM_VERSION=1.1.0/' .env
docker compose pull && docker compose up -d --wait
```

The migrations run before the console starts. Read
[docs/upgrading.md](../../docs/upgrading.md) first.

## Restore a backup

```sh
docker compose stop control-plane gateway
docker compose exec -T postgres pg_restore -U stratum -d stratum --clean --if-exists < backups/stratum-<date>.dump
docker compose start control-plane gateway
```

## Remove

`docker compose down` stops it and keeps the data; `docker compose down -v`
deletes the database, Valkey and the certificates too. `./backups` and
`.env` stay.
