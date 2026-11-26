-- ============================================================
--  Migration 053 — telling organizations a model they use retires
-- ============================================================
--
-- The catalog says when a model retires (ai_models.deprecated_on, from the
-- feed). From 1.0 the control plane tells each organization that names it
-- in a policy or a route, or used it in the last 30 days: a month before
-- (31 days) and again a week before (7 days), by email to its Owners and
-- Admins and the team managers of the teams it touches, and by its alerts
-- of type "model_retiring". This table keeps what was told, so each step
-- is told once, by one control plane replica.
--
-- Additive.

BEGIN;

CREATE TABLE IF NOT EXISTS model_retirement_notices (
  org_id        UUID        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  provider      TEXT        NOT NULL,
  model_id      TEXT        NOT NULL,
  deprecated_on DATE        NOT NULL,
  stage         TEXT        NOT NULL CHECK (stage IN ('month', 'week')),
  notified_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, provider, model_id, deprecated_on, stage)
);

COMMIT;
