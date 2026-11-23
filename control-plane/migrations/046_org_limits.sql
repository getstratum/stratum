-- ============================================================
--  Migration 046 — an organization's plan limits (ADR-0020, from 1.0)
-- ============================================================
--
-- organizations.limits holds the ceilings the organization's plan sets,
-- which its own administrators cannot change or exceed:
--
--   people              active people (console or applications)
--   agents              active agents
--   teams               teams
--   gateways            registered gateways that are not disabled
--   monthly_tokens      tokens per UTC month, every team together
--   monthly_budget_usd  spend per UTC month, every team together
--   retention_days      days the console keeps requests (request_logs and
--                       task_outcomes); 31 or more
--
-- A key that is missing is not limited, so '{}' (every organization on
-- upgrade) changes nothing. The console checks the first four when
-- something is created or turned back on; gateways from 1.0 enforce the
-- monthly ones (they arrive with every sync); the daily maintenance deletes
-- requests older than the retention. Lowering a limit never deletes what
-- the organization already has: it only stops it from adding more.
--
-- organizations.plan_name is the plan's name as people see it ("Fijado por
-- tu plan (Empresa)"). Named plans live with whoever runs the installation
-- (stratum-operator, or the CLI): the console only gets the resolved limits.
-- org_profiles (migration 016) stays unused.
--
-- Additive: the previous console neither reads nor writes either column.

BEGIN;

ALTER TABLE organizations ADD COLUMN IF NOT EXISTS limits JSONB NOT NULL DEFAULT '{}';
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS plan_name TEXT;
ALTER TABLE organizations DROP CONSTRAINT IF EXISTS organizations_limits_object;
ALTER TABLE organizations ADD CONSTRAINT organizations_limits_object
  CHECK (jsonb_typeof(limits) = 'object');

-- The retention deletes by organization and age.
CREATE INDEX IF NOT EXISTS idx_task_outcomes_org_created ON task_outcomes (org_id, created_at);

COMMIT;
