-- ============================================================
--  Migration 024 — a model catalog that changes without a release
-- ============================================================
--
-- 1. ai_models rows say where they came from (a release's migration, or the
--    catalog feed the control plane reads every day, catalog/models.json)
--    and when the provider retires them.
-- 2. model_catalog_state: the last feed checked and applied.
-- 3. org_model_settings: per organization, models turned off (gateways
--    refuse them even under "all models") and negotiated prices (usage is
--    costed with them).
-- 4. provider_models: models a provider listed for an organization in a
--    connection test, so models outside the catalog can be chosen in
--    policies (they have no price).
-- 5. stratum_org_denied_models(): what gateways get as denied_models, and the
--    version bumps that send it.

BEGIN;

ALTER TABLE ai_models ADD COLUMN IF NOT EXISTS deprecated_on DATE;
ALTER TABLE ai_models ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'release';

CREATE TABLE IF NOT EXISTS model_catalog_state (
  id            BOOLEAN PRIMARY KEY DEFAULT true CHECK (id),
  source        TEXT,
  feed_updated  TEXT,          -- the feed's own "updated" field
  models        INTEGER,
  changed       INTEGER,
  checked_at    TIMESTAMPTZ,
  applied_at    TIMESTAMPTZ,
  error         TEXT
);
INSERT INTO model_catalog_state (id) VALUES (true) ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS org_model_settings (
  org_id                    UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  provider                  VARCHAR(50)  NOT NULL,
  model_id                  VARCHAR(200) NOT NULL,
  enabled                   BOOLEAN NOT NULL DEFAULT true,
  cost_per_1k_input_tokens  NUMERIC(10,6) CHECK (cost_per_1k_input_tokens >= 0),
  cost_per_1k_output_tokens NUMERIC(10,6) CHECK (cost_per_1k_output_tokens >= 0),
  updated_by                TEXT,
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, provider, model_id)
);

CREATE TABLE IF NOT EXISTS provider_models (
  org_id    UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  provider  VARCHAR(50)  NOT NULL,
  model_id  VARCHAR(200) NOT NULL,
  seen_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, provider, model_id)
);

-- Every "provider/ID" form of the models an organization turned off: the
-- catalog's aliases too, so a request by alias is refused as well. Only the
-- qualified form: turning off openai/o3 must not refuse another provider's
-- model of the same name.
CREATE OR REPLACE FUNCTION stratum_org_denied_models(org UUID)
RETURNS TEXT[] LANGUAGE sql STABLE AS $$
  SELECT COALESCE(array_agg(DISTINCT s.provider || '/' || n ORDER BY s.provider || '/' || n), '{}')
    FROM org_model_settings s
    LEFT JOIN ai_models m ON m.provider = s.provider AND m.model_id = s.model_id,
         unnest(ARRAY[s.model_id::text] || COALESCE(m.aliases, '{}')) AS n
   WHERE s.org_id = org AND NOT s.enabled
$$;

-- Turning a model off or on is a new version of every policy of the
-- organization; a price change is not.
CREATE OR REPLACE FUNCTION stratum_org_models_changed()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF NOT OLD.enabled THEN
      UPDATE policies SET updated_at = now() WHERE org_id = OLD.org_id;
    END IF;
  ELSIF TG_OP = 'INSERT' THEN
    IF NOT NEW.enabled THEN
      UPDATE policies SET updated_at = now() WHERE org_id = NEW.org_id;
    END IF;
  ELSIF NEW.enabled IS DISTINCT FROM OLD.enabled THEN
    UPDATE policies SET updated_at = now() WHERE org_id = NEW.org_id;
  END IF;
  RETURN NULL;
END;
$$;
DROP TRIGGER IF EXISTS trg_org_model_settings_changed ON org_model_settings;
CREATE TRIGGER trg_org_model_settings_changed
  AFTER INSERT OR UPDATE OR DELETE ON org_model_settings
  FOR EACH ROW EXECUTE FUNCTION stratum_org_models_changed();

-- A catalog change to a model's IDs also changes the deny list of every
-- organization that turned that model off.
CREATE OR REPLACE FUNCTION stratum_catalog_changed()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  changed TEXT[];
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT array_agg(n) INTO changed
      FROM new_rows m, unnest(stratum_catalog_names(m.provider, m.model_id, m.aliases)) AS n;
  ELSIF TG_OP = 'DELETE' THEN
    SELECT array_agg(n) INTO changed
      FROM old_rows m, unnest(stratum_catalog_names(m.provider, m.model_id, m.aliases)) AS n;
  ELSE
    SELECT array_agg(n) INTO changed
      FROM new_rows nw JOIN old_rows o ON o.id = nw.id,
           unnest(stratum_catalog_names(nw.provider, nw.model_id, nw.aliases)
               || stratum_catalog_names(o.provider, o.model_id, o.aliases)) AS n
     WHERE (o.provider, o.model_id, o.aliases) IS DISTINCT FROM (nw.provider, nw.model_id, nw.aliases);
  END IF;
  IF changed IS NOT NULL THEN
    UPDATE policies SET updated_at = now()
     WHERE (NOT COALESCE(allow_all_models, false) AND allowed_models && changed)
        OR org_id IN (SELECT s.org_id FROM org_model_settings s
                       WHERE NOT s.enabled AND s.provider || '/' || s.model_id = ANY(changed));
  END IF;
  RETURN NULL;
END;
$$;

COMMIT;
