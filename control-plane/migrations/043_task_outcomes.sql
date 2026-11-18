-- Tasks and how they end (the gateway's ADR-0019): the X-Stratum-Task each
-- request named, and what the application said when the task ended. With
-- both, the console measures an agent by its results: tasks resolved on its
-- own, handed over to a person, failed, and what each one cost. Additive.
BEGIN;

-- The task a request named, from 0.9 gateways.
ALTER TABLE request_logs ADD COLUMN IF NOT EXISTS task TEXT;
CREATE INDEX IF NOT EXISTS idx_rl_agent_task ON request_logs (agent_id, task, created_at) WHERE task IS NOT NULL;

-- A task's end, as the application said it. A task may end more than once
-- (reopened, then resolved): the last one counts. The ID is the gateway's
-- record ID, so a batch sent again stores it once.
CREATE TABLE IF NOT EXISTS task_outcomes (
  id          UUID PRIMARY KEY,
  created_at  TIMESTAMPTZ NOT NULL,
  org_id      UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  team_id     UUID,
  user_id     UUID,
  agent_id    UUID,
  task        TEXT NOT NULL CHECK (task ~ '^[A-Za-z0-9._:-]{1,100}$'),
  outcome     TEXT NOT NULL CHECK (outcome IN ('resolved', 'escalated', 'failed')),
  reason      TEXT CHECK (reason ~ '^[a-z0-9_]{1,40}$'),
  instance_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_task_outcomes_agent ON task_outcomes (org_id, agent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_task_outcomes_task  ON task_outcomes (org_id, agent_id, task);

COMMIT;
