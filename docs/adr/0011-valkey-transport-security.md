# ADR-0011: TLS and token authentication between gateways and Valkey

- **Status:** Accepted
- **Date:** 2026-10-18

## Context

Gateways keep two things in Valkey: the month's token counters per team
(ADR-0004) and an encrypted copy of their snapshot (ADR-0008). The snapshot
copy is encrypted by the gateway, so Valkey only ever sees ciphertext; the
counters and the commands themselves travel in clear text, and any client
that reaches the endpoint can read or reset them. The GCP reference
deployment relied on the network alone (Private Service Connect inside the
VPC), and listed TLS and authentication as missing before production.

The gateway's client already spoke `rediss://` and sent `AUTH`, but only
trusted the system roots. Managed services issue the server certificate
from a CA of their own (Memorystore creates one per instance), so TLS could
not be turned on there.

Memorystore for Valkey offers two kinds of authentication:

- **IAM:** the client sends a Google access token as the password. Tokens
  last an hour and every new connection needs a valid one, so starting a
  gateway, or reconnecting after Valkey fails over, needs Google's token
  service to be up, and the gateway would need a Google identity and a
  role. Today it needs no Google permission at all.
- **Token:** Memorystore generates a static token for the instance's
  `default` user (two can coexist, for rotation). It is an ordinary Valkey
  ACL password: nothing outside the region is involved in a connection.

## Decision

1. The gateway accepts `STRATUM_VALKEY_CA_FILE`, a PEM bundle trusted for
   `rediss://` *instead of* the system roots. It may hold several CAs (a
   rotation); it is read at start. The certificate must name the host the
   URL names, IP addresses included. A CA file with a plain `redis://` URL
   is a configuration error, not something silently ignored.
2. The Helm chart mounts it from a ConfigMap (`quota.valkey.caConfigMap`,
   key `ca.crt`); the token goes in `STRATUM_VALKEY_PASSWORD` in the
   existing secret.
3. The GCP reference deployment creates Memorystore with
   `transit_encryption_mode = SERVER_AUTHENTICATION` (per-instance CA) and
   `authorization_mode = TOKEN_AUTH`. `make deploy` reads the CA from
   Terraform and the default user's token from the Memorystore API on every
   run; neither is stored in Secret Manager.
4. Not IAM authentication, for the reason ADR-0008 keeps the snapshot copy
   in Valkey: what the data plane needs to start and serve stays in its own
   failure domain.

## Consequences

- Valkey traffic is encrypted and authenticated, also inside the VPC.
- The token is a long-lived secret. Rotating it: add a second token in
  Memorystore, run `make deploy` (it picks an active one) so pods restart
  with it, then delete the old token.
- A CA rotation (Memorystore offers the new CA years ahead) needs the new
  bundle in the ConfigMap and a restart of the gateways before the old CA
  expires.
- Terraform needs the `google-beta` provider for `TOKEN_AUTH`, until the
  `google` provider accepts it.
- Both settings are immutable on a Memorystore instance: an existing test
  environment gets a new, empty instance on the next `make up`, so the
  month's counters start from zero.
