-- ============================================================
--  Migration 004 — Agents
-- ============================================================

CREATE TABLE IF NOT EXISTS agents (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  team_id         UUID REFERENCES teams(id),
  name            VARCHAR(255) NOT NULL,
  description     TEXT,
  default_model   VARCHAR(100),
  default_provider VARCHAR(50),
  api_key_hash    VARCHAR(255) UNIQUE,
  api_key_prefix  VARCHAR(20),
  is_active       BOOLEAN DEFAULT true,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agents_key  ON agents (api_key_hash);
CREATE INDEX IF NOT EXISTS idx_agents_team ON agents (team_id);

-- Add agent_id to the parent table only — Postgres propagates to partitions automatically
ALTER TABLE request_logs ADD COLUMN IF NOT EXISTS agent_id UUID;

CREATE INDEX IF NOT EXISTS idx_rl_agent ON request_logs (agent_id, created_at DESC);
