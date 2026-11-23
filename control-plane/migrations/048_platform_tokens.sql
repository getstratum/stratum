-- ============================================================
--  Migration 048 — the platform API's tokens (ADR-0020, from 1.0)
-- ============================================================
--
-- A platform token belongs to no organization: it is how whoever runs the
-- installation (stratum-operator, or their own automation) lists, creates,
-- suspends, deletes and sets the plan of organizations, and reads their
-- usage for billing, through /api/platform. It never reaches inside an
-- organization: its people, policies, credentials or requests.
--
-- Only `stratum-admin platform-token-create` makes one, with a name and an
-- expiry of at most a year; it is shown once and only its SHA-256 is kept.
-- What it does is in platform_audit (migration 047) as "platform:<name>".
-- An installation without platform tokens has no platform API.

BEGIN;

CREATE TABLE IF NOT EXISTS platform_tokens (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT        NOT NULL,
  token_hash    TEXT        NOT NULL UNIQUE,
  token_prefix  TEXT        NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at    TIMESTAMPTZ NOT NULL,
  last_used_at  TIMESTAMPTZ,
  revoked_at    TIMESTAMPTZ,
  CHECK (expires_at <= created_at + interval '366 days')
);

COMMIT;
