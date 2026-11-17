-- Images and transcriptions (the gateway's ADR-0018): what they are priced
-- by. Additive.
BEGIN;

-- What a request made or heard, from 0.8 gateways.
ALTER TABLE request_logs ADD COLUMN IF NOT EXISTS images        INTEGER       CHECK (images >= 0);
ALTER TABLE request_logs ADD COLUMN IF NOT EXISTS audio_seconds NUMERIC(10,2) CHECK (audio_seconds >= 0);

-- A price per image made and per minute of audio heard, beside the price
-- per token: the catalog's, and the organization's own.
ALTER TABLE ai_models ADD COLUMN IF NOT EXISTS cost_per_image        NUMERIC(10,6) CHECK (cost_per_image >= 0);
ALTER TABLE ai_models ADD COLUMN IF NOT EXISTS cost_per_audio_minute NUMERIC(10,6) CHECK (cost_per_audio_minute >= 0);
ALTER TABLE org_model_settings ADD COLUMN IF NOT EXISTS cost_per_image        NUMERIC(10,6) CHECK (cost_per_image >= 0);
ALTER TABLE org_model_settings ADD COLUMN IF NOT EXISTS cost_per_audio_minute NUMERIC(10,6) CHECK (cost_per_audio_minute >= 0);

-- The catalog feed brings their list prices (catalog/models.json:
-- per_image, per_audio_minute).

COMMIT;
