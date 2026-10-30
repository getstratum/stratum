-- 034_sso.sql
--
-- Signing in with the organization's own identity provider (OpenID
-- Connect: Google Workspace, Microsoft Entra ID, Okta...), to the console
-- and to the applications it signs people in to (lib/sso.js). One provider
-- per organization, chosen by the email's domain at sign-in. Only people
-- already in Users get in: nobody is created by signing in.
--
--   enforce   the password no longer works for the provider's domains,
--             except for Owners (their way in if the provider fails)

BEGIN;

CREATE TABLE IF NOT EXISTS sso_providers (
  org_id                   UUID        PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  kind                     TEXT        NOT NULL CHECK (kind IN ('google', 'oidc')),
  issuer                   TEXT        NOT NULL,
  client_id                TEXT        NOT NULL,
  client_secret_encrypted  TEXT        NOT NULL,
  domains                  TEXT[]      NOT NULL,
  enforce                  BOOLEAN     NOT NULL DEFAULT false,
  enabled                  BOOLEAN     NOT NULL DEFAULT true,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sso_providers_domains ON sso_providers USING gin (domains);

-- A sign-in on its way to the provider and back: bound to the browser that
-- started it (a cookie holds the other half), for 10 minutes.
CREATE TABLE IF NOT EXISTS sso_logins (
  state_hash      TEXT        PRIMARY KEY,
  browser_hash    TEXT        NOT NULL,
  org_id          UUID        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  nonce           TEXT        NOT NULL,
  verifier        TEXT        NOT NULL,
  login_hint      TEXT,
  interaction     TEXT,       -- an application's sign-in (oidc_interactions), or NULL for the console
  expires_at      TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS sso_logins_expires ON sso_logins (expires_at);

COMMIT;
