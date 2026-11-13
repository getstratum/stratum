-- 038_model_kinds.sql
--
-- What kind of model each one is (lib/model-kind.js): chat, embedding,
-- image, transcription, speech, moderation or other. NULL everywhere means
-- "not said here": the console then takes the next source, and in the end
-- the model's ID.
--
--   ai_models.kind            the catalog's (catalog/models.json "kind")
--   provider_models.kind      what the provider said when it listed the model
--   org_model_settings.kind   the organization's own choice, which wins
--
-- Gateways get the kind with the model list, which is not versioned: a
-- change reaches them with the next sync and gives no policy a new version.

BEGIN;

ALTER TABLE ai_models ADD COLUMN IF NOT EXISTS kind TEXT
  CHECK (kind IN ('chat', 'embedding', 'image', 'transcription', 'speech', 'moderation', 'other'));
ALTER TABLE provider_models ADD COLUMN IF NOT EXISTS kind TEXT
  CHECK (kind IN ('chat', 'embedding', 'image', 'transcription', 'speech', 'moderation', 'other'));
ALTER TABLE org_model_settings ADD COLUMN IF NOT EXISTS kind TEXT
  CHECK (kind IN ('chat', 'embedding', 'image', 'transcription', 'speech', 'moderation', 'other'));

COMMIT;
