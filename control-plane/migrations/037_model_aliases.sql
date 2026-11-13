-- 037_model_aliases.sql
--
-- Model aliases (ADR-0015; "Rutas" in the console, since the catalog
-- already calls a model's other IDs aliases): a name and an ordered list of
-- up to four provider/model targets. A request for "stratum/<name>" goes to
-- the first target the team's policy allows, and on to the next while a
-- provider fails. Gateways get the whole list with every sync (not
-- versioned), like the model list.

BEGIN;

CREATE TABLE IF NOT EXISTS model_aliases (
  org_id     UUID        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name       VARCHAR(50) NOT NULL CHECK (name ~ '^[a-z0-9][a-z0-9._-]{0,49}$'),
  targets    JSONB       NOT NULL CHECK (jsonb_typeof(targets) = 'array'
                                         AND jsonb_array_length(targets) BETWEEN 1 AND 4),
  description TEXT       NOT NULL DEFAULT '',
  updated_by TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, name)
);

COMMIT;
