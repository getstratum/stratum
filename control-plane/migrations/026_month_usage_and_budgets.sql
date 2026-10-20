-- ============================================================
--  Migration 026 — the month's usage per team, and budgets that cut
-- ============================================================
--
-- 1. team_usage_monthly: tokens, cost and requests per team and UTC month,
--    kept by a statement trigger on request_logs, so every writer (usage
--    ingest, seeds, imports) updates it and a sync reads one small table
--    instead of summing the month's logs. Backfilled for this month and
--    the previous one. Sent to gateways with each sync (month_usage):
--    a floor for their token quota and the spend for budgets.
-- 2. policies.budget_enforced: a policy chooses whether gateways refuse
--    its teams' requests once the month's spend reaches the budget.
--    Off for every existing policy: until 0.3 the budget was a reference,
--    and turning it on silently would cut teams on upgrade.
-- 3. A team's own budget is part of what gateways enforce, so changing it
--    is a new version of the team's policy entry.
-- 4. policies.max_tokens_per_request is enforced by gateways from 0.3
--    (requests asking for more are lowered to it). It was stored and never
--    applied, and every policy got 4096 by default: those defaults are
--    cleared (no limit), so upgrading changes nothing for them. Values an
--    administrator set to something else start applying.
--
-- Additive for the previous console: it neither reads nor writes the new
-- table or column, and its inserts into request_logs fire the trigger.

BEGIN;

CREATE TABLE IF NOT EXISTS team_usage_monthly (
  org_id      UUID          NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  team_id     UUID          NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  month       DATE          NOT NULL,             -- first day of the UTC month
  tokens      BIGINT        NOT NULL DEFAULT 0,   -- input + output
  cost_usd    NUMERIC(16,6) NOT NULL DEFAULT 0,
  requests    BIGINT        NOT NULL DEFAULT 0,
  updated_at  TIMESTAMPTZ   NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, month, team_id)
);

CREATE OR REPLACE FUNCTION stratum_count_team_usage()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO team_usage_monthly AS u (org_id, team_id, month, tokens, cost_usd, requests, updated_at)
  SELECT n.org_id, n.team_id, date_trunc('month', n.created_at AT TIME ZONE 'UTC')::date,
         SUM(COALESCE(n.tokens_input, 0) + COALESCE(n.tokens_output, 0)),
         SUM(COALESCE(n.cost_usd, 0)), COUNT(*), now()
    FROM new_rows n
    -- A team deleted meanwhile has no row to count against.
    JOIN teams t ON t.id = n.team_id
   WHERE n.team_id IS NOT NULL AND n.org_id IS NOT NULL
   GROUP BY 1, 2, 3
  ON CONFLICT (org_id, month, team_id) DO UPDATE
     SET tokens     = u.tokens   + EXCLUDED.tokens,
         cost_usd   = u.cost_usd + EXCLUDED.cost_usd,
         requests   = u.requests + EXCLUDED.requests,
         updated_at = now();
  RETURN NULL;
END;
$$;

-- Creating the trigger locks out inserts until COMMIT, so the backfill
-- below and the trigger together count every row once.
DROP TRIGGER IF EXISTS trg_request_logs_team_usage ON request_logs;
CREATE TRIGGER trg_request_logs_team_usage
  AFTER INSERT ON request_logs
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION stratum_count_team_usage();

DELETE FROM team_usage_monthly
 WHERE month >= (date_trunc('month', now() AT TIME ZONE 'UTC') - INTERVAL '1 month')::date;
INSERT INTO team_usage_monthly (org_id, team_id, month, tokens, cost_usd, requests)
SELECT r.org_id, r.team_id, date_trunc('month', r.created_at AT TIME ZONE 'UTC')::date,
       SUM(COALESCE(r.tokens_input, 0) + COALESCE(r.tokens_output, 0)),
       SUM(COALESCE(r.cost_usd, 0)), COUNT(*)
  FROM request_logs r
  JOIN teams t ON t.id = r.team_id
 WHERE r.created_at >= (date_trunc('month', now() AT TIME ZONE 'UTC') - INTERVAL '1 month') AT TIME ZONE 'UTC'
   AND r.org_id IS NOT NULL
 GROUP BY 1, 2, 3;

ALTER TABLE policies ADD COLUMN IF NOT EXISTS budget_enforced BOOLEAN NOT NULL DEFAULT false;

CREATE OR REPLACE FUNCTION stratum_bump_team_policy_version()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.policy_id IS DISTINCT FROM OLD.policy_id
     OR NEW.monthly_budget_usd IS DISTINCT FROM OLD.monthly_budget_usd THEN
    NEW.policy_version := nextval('stratum_version_seq');
  END IF;
  RETURN NEW;
END;
$$;

UPDATE policies SET max_tokens_per_request = NULL WHERE max_tokens_per_request = 4096;
ALTER TABLE policies ALTER COLUMN max_tokens_per_request DROP DEFAULT;

COMMIT;
