-- ============================================================
--  Migration 008 — Provider API keys stored in DB
-- ============================================================
-- Keys stored here take priority over environment variables.
-- This allows adding/changing provider keys from the UI
-- without rebuilding or restarting the stack.
-- The proxy reloads providers every 60 seconds automatically.

ALTER TABLE providers ADD COLUMN IF NOT EXISTS api_key TEXT;

-- Index for fast model lookups by policy selector
CREATE INDEX IF NOT EXISTS idx_ai_models_provider ON ai_models (provider);
