-- 039_default_model.sql
--
-- A policy's default model (H-09 of the test plan): "provider/model" or a
-- route, "stratum/<name>". Gateways mark it in GET /v1/models, so a chat
-- client (the Enterprise portal) starts with it, and send to it the
-- requests that name no model. A route is the way to have a second model:
-- it skips what the policy does not allow and falls back while a provider
-- fails (ADR-0015).
--
--   policies.default_model     NULL: none
--   request_logs.alias         the route a request asked for, so the console
--                              can tell when the default route is falling back
--   default_model_notices      per policy, what the console last saw of its
--                              default and what it last told people about it
--
-- The column on policies gives the policy a new version (its trigger), so
-- gateways get the default with the next sync.

BEGIN;

ALTER TABLE policies ADD COLUMN IF NOT EXISTS default_model TEXT
  CHECK (default_model ~ '^[a-z0-9][a-z0-9-]{0,49}/.+$' AND length(default_model) <= 260);

ALTER TABLE request_logs ADD COLUMN IF NOT EXISTS alias TEXT;

CREATE TABLE IF NOT EXISTS default_model_notices (
  policy_id      UUID PRIMARY KEY REFERENCES policies(id) ON DELETE CASCADE,
  org_id         UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  -- ok | degraded (its route skips its first model) | unusable | falling_back
  state          TEXT NOT NULL CHECK (state IN ('ok', 'degraded', 'unusable', 'falling_back')),
  detail         TEXT NOT NULL DEFAULT '',
  since          TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- The last state people were told about, and when.
  notified_state TEXT,
  notified_at    TIMESTAMPTZ
);

COMMIT;
