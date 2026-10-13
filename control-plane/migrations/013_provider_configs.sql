-- =============================================================================
-- 013_provider_configs.sql — Stratum: customer provider configuration
-- =============================================================================
-- Applies on top of schema 001-012.
-- Idempotent: uses IF NOT EXISTS and column guards in DO blocks.
-- Depends on: stratum_version_seq (created in 012_stratum_sync.sql)
--
-- What it adds:
--   1. provider_configs table — customer API keys encrypted per provider
--   2. Extended columns on policies: pii_action, dlp_action, allowed_providers
--   3. Trigger auto-bump version on provider_configs
--   4. View v_stratum_provider_status
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. provider_configs
-- ---------------------------------------------------------------------------
-- api_key_encrypted: AES-256-GCM in base64, format "<iv_hex>:<ciphertext_b64>"
-- Encryption key lives in STRATUM_ENCRYPTION_KEY on the Control Plane.
-- In the sync channel the key travels in plaintext (TLS + Bearer auth).

CREATE TABLE IF NOT EXISTS provider_configs (
  id                TEXT        PRIMARY KEY,          -- pc_<random32hex>
  org_id            UUID        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  provider          TEXT        NOT NULL,             -- openai | anthropic | gemini | groq | azure | ollama
  display_name      TEXT        NOT NULL,
  api_key_encrypted TEXT        NOT NULL,             -- encrypted in DB
  base_url          TEXT,                             -- null = provider default
  extra_config      JSONB       NOT NULL DEFAULT '{}',-- azure_deployment, etc.
  enabled           BOOLEAN     NOT NULL DEFAULT true,
  version           BIGINT      NOT NULL DEFAULT nextval('stratum_version_seq'),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked           BOOLEAN     NOT NULL DEFAULT false
);

CREATE INDEX IF NOT EXISTS idx_provider_configs_org     ON provider_configs(org_id, enabled);
CREATE INDEX IF NOT EXISTS idx_provider_configs_version ON provider_configs(version);
CREATE UNIQUE INDEX IF NOT EXISTS idx_provider_configs_org_provider
  ON provider_configs(org_id, provider)
  WHERE revoked = false;

-- ---------------------------------------------------------------------------
-- 2. Trigger auto-bump version on provider_configs
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION stratum_bump_provider_version()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.version    := nextval('stratum_version_seq');
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_provider_configs_version ON provider_configs;
CREATE TRIGGER trg_provider_configs_version
  BEFORE UPDATE ON provider_configs
  FOR EACH ROW
  EXECUTE FUNCTION stratum_bump_provider_version();

-- ---------------------------------------------------------------------------
-- 3. Extended columns on policies
-- ---------------------------------------------------------------------------

-- Each column is added on its own: pii_action already exists from 010_pii.sql,
-- so guarding all three on it would silently skip dlp_action and
-- allowed_providers.
ALTER TABLE policies ADD COLUMN IF NOT EXISTS pii_action        TEXT NOT NULL DEFAULT 'off';
ALTER TABLE policies ADD COLUMN IF NOT EXISTS dlp_action        TEXT NOT NULL DEFAULT 'off';
ALTER TABLE policies ADD COLUMN IF NOT EXISTS allowed_providers TEXT[];  -- null = all enabled in the org

-- Check constraints: valid values
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_policies_pii_action') THEN
    ALTER TABLE policies
      ADD CONSTRAINT chk_policies_pii_action
        CHECK (pii_action IN ('off', 'log', 'redact', 'block'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_policies_dlp_action') THEN
    ALTER TABLE policies
      ADD CONSTRAINT chk_policies_dlp_action
        CHECK (dlp_action IN ('off', 'log', 'redact', 'block'));
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 4. View: active provider status by org
-- ---------------------------------------------------------------------------

CREATE OR REPLACE VIEW v_stratum_provider_status AS
SELECT
  pc.id,
  pc.org_id,
  o.name   AS org_name,
  pc.provider,
  pc.display_name,
  pc.base_url,
  pc.extra_config,
  pc.enabled,
  pc.revoked,
  pc.version,
  pc.updated_at
FROM provider_configs pc
JOIN organizations o ON o.id = pc.org_id
WHERE pc.revoked = false;

-- ---------------------------------------------------------------------------
-- Note on current_version calculation
-- ---------------------------------------------------------------------------
-- The sync route computes current_version with GREATEST across all versioned
-- tables. This is done in the application layer (sync/route.js):
--
--   SELECT GREATEST(
--     COALESCE((SELECT MAX(version)     FROM policies),                          0),
--     COALESCE((SELECT MAX(key_version) FROM users WHERE api_key_hash IS NOT NULL), 0),
--     COALESCE((SELECT MAX(version)     FROM provider_configs),                  0)
--   ) AS current_version

COMMIT;
