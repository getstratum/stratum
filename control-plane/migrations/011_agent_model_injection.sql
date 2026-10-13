-- ============================================================
--  Migration 011 — Agent model injection columns
-- ============================================================
-- Both the Node proxy and the Go Enterprise Gateway read
-- agents.default_model / agents.default_provider to override an agent's
-- request with the model the admin configured centrally (so agents never
-- need to know or hardcode which model/provider they call). These columns
-- were referenced by the application code but never added to this
-- database via migration — this closes that gap.

ALTER TABLE agents ADD COLUMN IF NOT EXISTS default_model    VARCHAR(255);
ALTER TABLE agents ADD COLUMN IF NOT EXISTS default_provider VARCHAR(100);
