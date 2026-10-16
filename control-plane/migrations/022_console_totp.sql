-- 022_console_totp.sql
--
-- Second factor for the console: TOTP (RFC 6238), required for Owner and
-- Admin, optional for the other console roles. docs/console/access-control.md.
--
-- - users.totp_secret_encrypted: the authenticator secret, encrypted with
--   STRATUM_ENCRYPTION_KEY like provider credentials (lib/secrets.js).
-- - users.totp_pending_secret_encrypted: a secret being set up, until the
--   person proves it works with a first code.
-- - users.totp_last_step: the last 30-second step accepted, so a code cannot
--   be used twice.
-- - console_login_challenges: between the password and the code. Holds no
--   session: only proof that the password was right, for 5 minutes and 5
--   tries.
-- - user_recovery_codes: one-time codes for a lost authenticator, hashed.
-- - console_sessions.enrollment_only: an Owner or Admin who has not set up
--   the second factor yet gets a session that can only set it up; their
--   sessions opened before this migration become such sessions.
--
-- Idempotent: safe to run more than once.

BEGIN;

ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_secret_encrypted         TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_pending_secret_encrypted TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_enabled_at               TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_last_step                BIGINT NOT NULL DEFAULT 0;

ALTER TABLE console_sessions ADD COLUMN IF NOT EXISTS enrollment_only BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS console_login_challenges (
  -- SHA-256 of the challenge the browser holds. The value is never stored.
  challenge_hash TEXT        PRIMARY KEY,
  user_id        UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at     TIMESTAMPTZ NOT NULL,
  attempts       INTEGER     NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_console_login_challenges_user ON console_login_challenges (user_id);

CREATE TABLE IF NOT EXISTS user_recovery_codes (
  id         BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id    UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash  TEXT        NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  used_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_user_recovery_codes_user ON user_recovery_codes (user_id) WHERE used_at IS NULL;

-- Sessions opened before this migration by an Owner or Admin: they now have
-- to set up the second factor before anything else, like a new sign-in.
-- (Later, a role change or a reset of the second factor ends the person's
-- sessions, so this is only needed once.)
UPDATE console_sessions s SET enrollment_only = true
  FROM users u
 WHERE u.id = s.user_id
   AND u.role IN ('owner', 'admin')
   AND u.totp_enabled_at IS NULL
   AND s.revoked_at IS NULL
   AND s.expires_at > now()
   AND NOT s.enrollment_only;

COMMIT;
