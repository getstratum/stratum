-- 018_provider_configs_console.sql
--
-- What the console's Providers page shows about a credential without ever
-- showing it: its last four characters, who set it and when. Configurations
-- saved before this migration have no hint; the console shows them as
-- "configured".
--
-- (One active configuration per provider and organization is already
-- enforced by idx_provider_configs_org_provider, from 013.)
--
-- Idempotent: safe to run more than once.

BEGIN;

ALTER TABLE provider_configs ADD COLUMN IF NOT EXISTS api_key_hint   TEXT;
ALTER TABLE provider_configs ADD COLUMN IF NOT EXISTS key_updated_by TEXT;
ALTER TABLE provider_configs ADD COLUMN IF NOT EXISTS key_updated_at TIMESTAMPTZ;

COMMIT;
