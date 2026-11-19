-- The version of its instructions an agent names (X-Stratum-Agent-Version,
-- the gateway's ADR-0019), on its requests and its tasks' ends: what the
-- console groups an agent's results by, to see what a change of prompt
-- did. Additive.
BEGIN;

ALTER TABLE request_logs  ADD COLUMN IF NOT EXISTS agent_version TEXT;
ALTER TABLE task_outcomes ADD COLUMN IF NOT EXISTS agent_version TEXT
  CHECK (agent_version ~ '^[A-Za-z0-9._:-]{1,64}$');

COMMIT;
