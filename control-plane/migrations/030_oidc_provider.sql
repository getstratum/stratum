-- 030_oidc_provider.sql
--
-- The console as an OpenID Connect provider for the organization's own
-- applications (a chat portal, an internal tool): people sign in to them
-- with their console account, password and second factor, and the
-- application gets an ID token with who they are, their organization and
-- their team. Authorization code flow with PKCE only.
--
-- oidc_clients       applications registered by an Owner or Admin; the
--                    secret is stored as a SHA-256 (it is 32 random bytes)
-- oidc_interactions  a sign-in in progress (/authorize → the sign-in page),
--                    10 minutes
-- oidc_codes         authorization codes, 60 seconds, single use
-- oidc_keys          the RS256 signing keys; the private key encrypted with
--                    STRATUM_ENCRYPTION_KEY
--
-- Idempotent: safe to run more than once.

BEGIN;

CREATE TABLE IF NOT EXISTS oidc_clients (
  id             TEXT        PRIMARY KEY,               -- the client_id, "app_<hex>"
  org_id         UUID        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name           TEXT        NOT NULL,
  secret_hash    TEXT        NOT NULL,
  redirect_uris  TEXT[]      NOT NULL,
  require_mfa    BOOLEAN     NOT NULL DEFAULT true,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at     TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_oidc_clients_org ON oidc_clients (org_id);

CREATE TABLE IF NOT EXISTS oidc_interactions (
  id_hash     TEXT        PRIMARY KEY,
  client_id   TEXT        NOT NULL REFERENCES oidc_clients(id) ON DELETE CASCADE,
  params      JSONB       NOT NULL,                     -- redirect_uri, state, nonce, scope, code_challenge
  user_id     UUID        REFERENCES users(id) ON DELETE CASCADE, -- set once the password was right
  expires_at  TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS oidc_codes (
  code_hash   TEXT        PRIMARY KEY,
  client_id   TEXT        NOT NULL REFERENCES oidc_clients(id) ON DELETE CASCADE,
  user_id     UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  params      JSONB       NOT NULL,
  amr         TEXT[]      NOT NULL,
  auth_time   TIMESTAMPTZ NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  used_at     TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS oidc_keys (
  kid                    TEXT        PRIMARY KEY,
  public_jwk             JSONB       NOT NULL,
  private_pem_encrypted  TEXT        NOT NULL,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  retired_at             TIMESTAMPTZ
);

COMMIT;
