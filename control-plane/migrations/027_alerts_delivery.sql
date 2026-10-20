-- ============================================================
--  Migration 027 — alerts are sent
-- ============================================================
--
-- The control plane evaluates active alerts every few minutes and sends one
-- message per alert and month (lib/alert-delivery.js). last_fired_at already
-- records the send; these columns record the last failure, shown in the
-- console, and the last test message (one per minute at most).
--
-- Additive: the previous console ignores the columns.

BEGIN;

ALTER TABLE alerts ADD COLUMN IF NOT EXISTS last_error    TEXT;
ALTER TABLE alerts ADD COLUMN IF NOT EXISTS last_error_at TIMESTAMPTZ;
ALTER TABLE alerts ADD COLUMN IF NOT EXISTS last_test_at  TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_alerts_active ON alerts (team_id) WHERE is_active;

COMMIT;
