-- 036_service_tokens.sql
--
-- Service tokens: the console's API for automation (scripts, Terraform, an
-- identity bridge that provisions people with SCIM). An Owner makes one
-- with a name, the permissions it carries (a subset of lib/authz.js) and
-- an expiry of at most a year; the token is shown once and only its hash
-- is kept. It acts on the whole organization, never as a person: it signs
-- no one in, sets no passwords, makes no Owners and makes no tokens. What
-- it does is in the audit log as "token:<name>" (lib/service-tokens.js).

BEGIN;

CREATE TABLE IF NOT EXISTS service_tokens (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        UUID        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name          TEXT        NOT NULL,
  token_hash    TEXT        NOT NULL UNIQUE,
  token_prefix  TEXT        NOT NULL,
  scopes        TEXT[]      NOT NULL,
  created_by    UUID        REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at    TIMESTAMPTZ NOT NULL,
  last_used_at  TIMESTAMPTZ,
  revoked_at    TIMESTAMPTZ,
  CHECK (expires_at <= created_at + interval '366 days')
);
CREATE INDEX IF NOT EXISTS service_tokens_org ON service_tokens (org_id, created_at DESC);

COMMIT;
