-- 041_model_capabilities.sql
--
-- What a chat model can do besides text (lib/model-capabilities.js): read
-- images (vision) and call tools (tools). NULL everywhere means "not said
-- here": the console then takes the next source, and in the end the model's
-- ID.
--
--   ai_models.vision / tools            the catalog's (catalog/models.json)
--   provider_models.vision / tools      what the provider said when it listed the model
--   org_model_settings.vision / tools   the organization's own choice, which wins
--
-- Gateways get them with the model list (GET /v1/models "capabilities"),
-- which is not versioned: a change reaches them with the next sync.

BEGIN;

ALTER TABLE ai_models ADD COLUMN IF NOT EXISTS vision BOOLEAN;
ALTER TABLE ai_models ADD COLUMN IF NOT EXISTS tools BOOLEAN;
ALTER TABLE provider_models ADD COLUMN IF NOT EXISTS vision BOOLEAN;
ALTER TABLE provider_models ADD COLUMN IF NOT EXISTS tools BOOLEAN;
ALTER TABLE org_model_settings ADD COLUMN IF NOT EXISTS vision BOOLEAN;
ALTER TABLE org_model_settings ADD COLUMN IF NOT EXISTS tools BOOLEAN;

COMMIT;
