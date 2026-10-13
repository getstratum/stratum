-- 014_policy_sync_columns.sql
--
-- Columns the sync endpoint (/api/internal/sync) reads from policies but
-- that no earlier migration created. Without them the sync query fails and
-- no gateway can receive configuration.
--
--   allow_all_models  true = ignore allowed_models and permit every model
--   revoked           true = the team using this policy is disabled
--
-- Idempotent: safe to run on every start.

ALTER TABLE policies ADD COLUMN IF NOT EXISTS allow_all_models BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE policies ADD COLUMN IF NOT EXISTS revoked          BOOLEAN NOT NULL DEFAULT false;
