-- 016_console_authz.sql
--
-- Console access control (fase 0 of docs/console):
--   1. Five fixed roles: owner, admin, team_manager, auditor, member.
--   2. console_sessions: server-side sessions, so a session can be revoked
--      (logout, deactivation, role change) instead of living until a JWT
--      expires.
--   3. Login throttling columns on users.
--   4. audit_log: append-only record of console actions, denials included.
--   5. organizations.status, and org_profiles + organizations.profile_id
--      reserved for the platform operator's organization profiles (EE).
--   6. The demo seed's public credentials stop working.
--
-- Idempotent: safe to run more than once.

BEGIN;

-- 1. Roles -------------------------------------------------------------------
--
-- Old values: org_admin, admin, user. org_admin becomes owner; user becomes
-- member. Nobody is promoted: an installation whose console was used through
-- the "Engineering team" rule needs an owner created with
--   stratum-admin create-owner   (see docs/console/access-control.md).

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
UPDATE users SET role = CASE role
    WHEN 'org_admin' THEN 'owner'
    WHEN 'user'      THEN 'member'
    ELSE role
  END
WHERE role IN ('org_admin', 'user');
UPDATE users SET role = 'member'
WHERE role IS NULL OR role NOT IN ('owner', 'admin', 'team_manager', 'auditor', 'member');
ALTER TABLE users ALTER COLUMN role SET DEFAULT 'member';
ALTER TABLE users ALTER COLUMN role SET NOT NULL;
ALTER TABLE users ADD CONSTRAINT users_role_check
  CHECK (role IN ('owner', 'admin', 'team_manager', 'auditor', 'member'));

-- Emails are compared case-insensitively at sign-in, so they are stored in
-- lower case and unique that way. (Fails if two accounts differ only in
-- case: resolve those by hand first.)
UPDATE users SET email = lower(email) WHERE email <> lower(email);
CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_key ON users (lower(email));

-- 2. Sessions ----------------------------------------------------------------

CREATE TABLE IF NOT EXISTS console_sessions (
  -- SHA-256 of the cookie value. The value itself is never stored.
  token_hash    TEXT        PRIMARY KEY,
  user_id       UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  org_id        UUID        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at    TIMESTAMPTZ NOT NULL,
  revoked_at    TIMESTAMPTZ,
  ip            TEXT,
  user_agent    TEXT
);
CREATE INDEX IF NOT EXISTS idx_console_sessions_user ON console_sessions (user_id) WHERE revoked_at IS NULL;

-- 3. Login throttling ----------------------------------------------------------

ALTER TABLE users ADD COLUMN IF NOT EXISTS failed_logins  INTEGER     NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS locked_until   TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at  TIMESTAMPTZ;

-- 4. Audit log ------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS audit_log (
  id            BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- No foreign keys: the record outlives the organization, user or object
  -- it talks about.
  org_id        UUID,
  actor_user_id UUID,
  actor_label   TEXT,
  actor_role    TEXT,
  action        TEXT        NOT NULL,
  target_type   TEXT,
  target_id     TEXT,
  result        TEXT        NOT NULL CHECK (result IN ('ok', 'denied', 'failed')),
  ip            TEXT,
  user_agent    TEXT,
  details       JSONB       NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_audit_log_org_at ON audit_log (org_id, at DESC);

-- Append-only. TRUNCATE (retention jobs run by an operator) does not fire
-- row triggers; UPDATE and DELETE from the application always fail.
CREATE OR REPLACE FUNCTION stratum_audit_log_append_only()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only';
END;
$$;

DROP TRIGGER IF EXISTS trg_audit_log_append_only ON audit_log;
CREATE TRIGGER trg_audit_log_append_only
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION stratum_audit_log_append_only();

-- 5. Organizations ----------------------------------------------------------------

ALTER TABLE organizations ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active';
ALTER TABLE organizations DROP CONSTRAINT IF EXISTS organizations_status_check;
ALTER TABLE organizations ADD CONSTRAINT organizations_status_check
  CHECK (status IN ('active', 'suspended'));

-- Organization profiles (EE): quotas and features an organization's admins
-- cannot change or exceed. Only the table and the reference exist so far.
CREATE TABLE IF NOT EXISTS org_profiles (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT        NOT NULL UNIQUE,
  settings    JSONB       NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS profile_id UUID REFERENCES org_profiles(id);

-- 6. Demo seed ---------------------------------------------------------------------
--
-- 002_seed.sql published two API keys (aig_sk_eng_test1234567890 and
-- aig_sk_mkt_test1234567890) and 003_auth.sql placeholder password hashes.
-- Anyone who read the repository could use them. Removing a key records a
-- revocation (migration 015), so gateways drop them in the next sync.

UPDATE users SET api_key_hash = NULL, api_key_prefix = NULL
WHERE api_key_hash IN (
  '3ba6ea2bd037fee129f1115ad2361d4692aa55d0c3e530fa5b82622792943d1f',
  'ff27ac1cbcd92ed9676d1d5002561bb09eda9a7259ddb7b89aeeb15b24a96cc2'
);
UPDATE users SET password_hash = NULL
WHERE id IN ('30000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000002')
  AND password_hash IN (
    '4a7d1ed414474e4033ac29ccb8653d9b:b1e4b6f9c3d2a5e8f7a4c9d0b3e6a8f2c5d8e1b4a7c0d3e6f9b2e5a8d1c4f7b0e3a6c9d2f5b8e1a4d7c0f3b6e9a2d5c8f1e4b7a0d3c6f9e2b5a8d1e4b7c0f3',
    '9b2e5a8d1c4f7b0e3a6c9d2f5b8e1a4d:a4c9d0b3e6a8f2c5d8e1b4a7c0d3e6f9b2e5a8d1c4f7b0e3a6c9d2f5b8e1a4d7c0f3b6e9a2d5c8f1e4b7a0d3c6f9e2b5a8d1e4b7c0f3a6c9d2f5b8e1a4d7'
  );

COMMIT;
