-- ============================================================
--  Migration 049 — invitations (ADR-0020, from 1.0)
-- ============================================================
--
-- An invitation is a link that works once, for 72 hours, where someone
-- sets their own password (and then their second factor, if their role
-- asks for one). Nobody else ever knows that password: not the Owner who
-- invited them, not whoever runs the installation.
--
-- Two kinds of people invite: whoever runs the installation, for the first
-- Owner of an organization (platform API, stratum-admin org-invite), and an
-- organization's Owners, Admins and team managers, for the people they may
-- add from the console (the same roles and teams as when adding them).
--
-- The account is created when the invitation is accepted, not before: an
-- open invitation does not count against the plan's people, and the email
-- stays free until then. A new invitation for the same email in the same
-- organization revokes the open one. Only the token's SHA-256 is kept.
--
-- Additive.

BEGIN;

CREATE TABLE IF NOT EXISTS invitations (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        UUID        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email         TEXT        NOT NULL,
  role          TEXT        NOT NULL CHECK (role IN ('owner', 'admin', 'team_manager', 'auditor', 'member')),
  team_id       UUID        REFERENCES teams(id) ON DELETE CASCADE,
  token_hash    TEXT        NOT NULL UNIQUE,
  invited_by    TEXT        NOT NULL,           -- a person's email, or "platform:<token>" / "stratum-admin (CLI)"
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at    TIMESTAMPTZ NOT NULL,
  accepted_at   TIMESTAMPTZ,
  revoked_at    TIMESTAMPTZ,
  user_id       UUID        REFERENCES users(id) ON DELETE SET NULL   -- the account it became
);
-- One open invitation per email and organization.
CREATE UNIQUE INDEX IF NOT EXISTS invitations_open
  ON invitations (org_id, lower(email)) WHERE accepted_at IS NULL AND revoked_at IS NULL;

COMMIT;
