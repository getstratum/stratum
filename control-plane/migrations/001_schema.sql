-- ============================================================
--  AI Governance MVP — Schema
-- ============================================================

-- Organizations
CREATE TABLE organizations (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name         VARCHAR(255) NOT NULL,
  domain       VARCHAR(255),
  plan_tier    VARCHAR(50) DEFAULT 'starter',  -- starter, professional, enterprise
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

-- Policies (defined by org admins, assigned to teams)
CREATE TABLE policies (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                  UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name                    VARCHAR(255) NOT NULL,
  allowed_models          TEXT[] NOT NULL DEFAULT '{}',   -- e.g. ['gpt-4o', 'claude-sonnet-4-6']
  max_tokens_per_request  INTEGER DEFAULT 4096,
  monthly_token_quota     BIGINT DEFAULT 1000000,         -- tokens/month for the whole team
  monthly_budget_usd      DECIMAL(10,2) DEFAULT 100.00,
  created_at              TIMESTAMPTZ DEFAULT NOW()
);

-- Teams
CREATE TABLE teams (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  policy_id           UUID REFERENCES policies(id),
  name                VARCHAR(255) NOT NULL,
  department          VARCHAR(255),
  monthly_budget_usd  DECIMAL(10,2),
  created_at          TIMESTAMPTZ DEFAULT NOW()
);

-- Users
CREATE TABLE users (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  team_id         UUID REFERENCES teams(id),
  email           VARCHAR(255) UNIQUE NOT NULL,
  name            VARCHAR(255),
  role            VARCHAR(50) DEFAULT 'user',    -- user | admin | org_admin
  api_key_hash    VARCHAR(255) UNIQUE,           -- SHA-256 of the raw key
  api_key_prefix  VARCHAR(20),                   -- shown in UI e.g. "aig_sk_eng_..."
  is_active       BOOLEAN DEFAULT true,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- AI Models catalog (cost data for spend calculations)
CREATE TABLE ai_models (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider                    VARCHAR(50) NOT NULL,    -- openai | anthropic
  model_id                    VARCHAR(100) NOT NULL,   -- gpt-4o | claude-sonnet-4-6
  display_name                VARCHAR(255) NOT NULL,
  cost_per_1k_input_tokens    DECIMAL(10,6) NOT NULL DEFAULT 0,
  cost_per_1k_output_tokens   DECIMAL(10,6) NOT NULL DEFAULT 0,
  is_active                   BOOLEAN DEFAULT true,
  created_at                  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(provider, model_id)
);

-- Request logs — partitioned by month for scale
-- NOTE: Only metadata is stored — NO prompt/response content
CREATE TABLE request_logs (
  id              UUID DEFAULT gen_random_uuid(),
  org_id          UUID NOT NULL,
  team_id         UUID,
  user_id         UUID,
  provider        VARCHAR(50) NOT NULL,
  model_id        VARCHAR(100) NOT NULL,
  tokens_input    INTEGER DEFAULT 0,
  tokens_output   INTEGER DEFAULT 0,
  cost_usd        DECIMAL(10,6) DEFAULT 0,
  status_code     INTEGER,
  latency_ms      INTEGER,
  is_stream       BOOLEAN DEFAULT false,
  error_message   TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

-- Partitions — add a new one each month
CREATE TABLE request_logs_2026_08 PARTITION OF request_logs FOR VALUES FROM ('2026-08-01') TO ('2026-09-01');
CREATE TABLE request_logs_2026_09 PARTITION OF request_logs FOR VALUES FROM ('2026-09-01') TO ('2026-10-01');
CREATE TABLE request_logs_2026_10 PARTITION OF request_logs FOR VALUES FROM ('2026-10-01') TO ('2026-11-01');
CREATE TABLE request_logs_2026_11 PARTITION OF request_logs FOR VALUES FROM ('2026-11-01') TO ('2026-12-01');
CREATE TABLE request_logs_2026_12 PARTITION OF request_logs FOR VALUES FROM ('2026-12-01') TO ('2027-01-01');
CREATE TABLE request_logs_2027_01 PARTITION OF request_logs FOR VALUES FROM ('2027-01-01') TO ('2027-02-01');

-- Indexes on the parent table propagate to all partitions
CREATE INDEX idx_rl_org_created  ON request_logs (org_id,  created_at DESC);
CREATE INDEX idx_rl_team_created ON request_logs (team_id, created_at DESC);
CREATE INDEX idx_rl_user_created ON request_logs (user_id, created_at DESC);

-- Alerts
CREATE TABLE alerts (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        UUID NOT NULL REFERENCES organizations(id),
  team_id       UUID REFERENCES teams(id),        -- NULL = org-level alert
  alert_type    VARCHAR(50) NOT NULL,              -- budget | quota | policy_violation
  threshold_pct INTEGER DEFAULT 80,               -- fire when usage reaches X%
  channel       VARCHAR(50) DEFAULT 'email',       -- email | slack (webhook)
  destination   VARCHAR(500) NOT NULL,             -- email address or Slack webhook URL
  is_active     BOOLEAN DEFAULT true,
  last_fired_at TIMESTAMPTZ,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);
