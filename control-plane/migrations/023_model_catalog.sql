-- 023_model_catalog.sql
--
-- Model catalog: aliases, provider names as gateways use them, and current
-- models and list prices.
--
-- - ai_models.aliases: other IDs that name the same model. Anthropic models
--   before the 4.6 generation have a dated ID and a short alias
--   (claude-haiku-4-5-20251001 / claude-haiku-4-5); OpenAI has the reverse
--   (gpt-5.5 / gpt-5.5-2026-04-23). A request may use either.
-- - stratum_expand_models(): a policy's allowed models plus the other IDs
--   of each catalog model it names. The sync sends the expanded list, so a
--   policy that allows a model allows every ID of it, and gateways keep
--   comparing names exactly.
-- - Costs of request_logs are looked up by ID or alias
--   (lib/usage-ingest.js).
-- - Provider names: the catalog used "google-gemini"; gateways and provider
--   configurations use "gemini". Costs of Gemini requests were 0.
-- - A change to a model's IDs changes what a policy that names it allows:
--   triggers bump those policies' versions, and gateways get the new lists
--   in the next sync. Price changes bump nothing.
--
-- Prices are list prices in USD per 1K tokens, as published by each
-- provider on 2026-10-17 (base input and output, standard tier; for models
-- priced by prompt length, the shortest tier). A price change applies to
-- requests ingested after it: stored costs are never recalculated.
--
-- Idempotent: safe to run more than once.

BEGIN;

ALTER TABLE ai_models ADD COLUMN IF NOT EXISTS aliases    TEXT[]      NOT NULL DEFAULT '{}';
ALTER TABLE ai_models ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

-- "google-gemini" → "gemini": rows that would collide are dropped first.
DELETE FROM ai_models g
 WHERE g.provider = 'google-gemini'
   AND EXISTS (SELECT 1 FROM ai_models m WHERE m.provider = 'gemini' AND m.model_id = g.model_id);
UPDATE ai_models SET provider = 'gemini', updated_at = now() WHERE provider = 'google-gemini';

INSERT INTO ai_models (provider, model_id, display_name, cost_per_1k_input_tokens, cost_per_1k_output_tokens, aliases)
VALUES
  -- Anthropic: https://platform.claude.com/docs/en/about-claude/pricing
  ('anthropic', 'claude-fable-5-1',           'Claude Fable 5.1',   0.010000, 0.050000, '{}'),
  ('anthropic', 'claude-opus-5-5',            'Claude Opus 5.5',    0.004000, 0.020000, '{}'),
  ('anthropic', 'claude-sonnet-5-5',          'Claude Sonnet 5.5',  0.002000, 0.010000, '{}'),
  ('anthropic', 'claude-haiku-5-5',           'Claude Haiku 5.5',   0.000100, 0.000500, '{}'),
  ('anthropic', 'claude-opus-5',              'Claude Opus 5',      0.005000, 0.025000, '{}'),
  ('anthropic', 'claude-sonnet-5',            'Claude Sonnet 5',    0.002000, 0.010000, '{}'),
  ('anthropic', 'claude-opus-4-8',            'Claude Opus 4.8',    0.005000, 0.025000, '{}'),
  ('anthropic', 'claude-opus-4-7',            'Claude Opus 4.7',    0.005000, 0.025000, '{}'),
  ('anthropic', 'claude-opus-4-6',            'Claude Opus 4.6',    0.005000, 0.025000, '{}'),
  ('anthropic', 'claude-sonnet-4-6',          'Claude Sonnet 4.6',  0.003000, 0.015000, '{}'),
  ('anthropic', 'claude-sonnet-4-5-20250929', 'Claude Sonnet 4.5',  0.003000, 0.015000, '{claude-sonnet-4-5}'),
  ('anthropic', 'claude-haiku-4-5-20251001',  'Claude Haiku 4.5',   0.001000, 0.005000, '{claude-haiku-4-5}'),
  -- OpenAI: https://developers.openai.com/api/docs/models
  ('openai',    'gpt-5.5',                    'GPT-5.5',            0.005000, 0.030000, '{gpt-5.5-2026-04-23}'),
  ('openai',    'gpt-5.4',                    'GPT-5.4',            0.002500, 0.015000, '{gpt-5.4-2026-03-05}'),
  -- Gemini: https://ai.google.dev/gemini-api/docs/pricing
  ('gemini',    'gemini-3.8-flash',           'Gemini 3.8 Flash',      0.000750, 0.003750, '{}'),
  ('gemini',    'gemini-3.6-flash',           'Gemini 3.6 Flash',      0.000750, 0.003750, '{}'),
  ('gemini',    'gemini-3.5-flash-lite',      'Gemini 3.5 Flash-Lite', 0.000300, 0.002500, '{}'),
  ('gemini',    'gemini-3.1-flash-lite',      'Gemini 3.1 Flash-Lite', 0.000250, 0.001500, '{}'),
  ('gemini',    'gemini-3.1-pro-preview',     'Gemini 3.1 Pro (preview)', 0.002000, 0.012000, '{}')
ON CONFLICT (provider, model_id) DO UPDATE SET
  display_name              = EXCLUDED.display_name,
  cost_per_1k_input_tokens  = EXCLUDED.cost_per_1k_input_tokens,
  cost_per_1k_output_tokens = EXCLUDED.cost_per_1k_output_tokens,
  aliases                   = EXCLUDED.aliases,
  updated_at                = now();

-- Every ID of each catalog model named in `models`, bare or as
-- "provider/model", in the same form it was named; plus `models` itself.
CREATE OR REPLACE FUNCTION stratum_expand_models(models TEXT[])
RETURNS TEXT[] LANGUAGE sql STABLE AS $$
  SELECT COALESCE(array_agg(DISTINCT x ORDER BY x), '{}')
    FROM (
      SELECT unnest(COALESCE(models, '{}')) AS x
      UNION ALL
      SELECT ids.name
        FROM ai_models m, unnest(ARRAY[m.model_id::text] || m.aliases) AS ids(name)
       WHERE (ARRAY[m.model_id::text] || m.aliases) && COALESCE(models, '{}')
      UNION ALL
      SELECT m.provider || '/' || ids.name
        FROM ai_models m, unnest(ARRAY[m.model_id::text] || m.aliases) AS ids(name)
       WHERE EXISTS (SELECT 1 FROM unnest(ARRAY[m.model_id::text] || m.aliases) AS q(name)
                      WHERE m.provider || '/' || q.name = ANY(COALESCE(models, '{}')))
    ) s
$$;

-- What a policy allows depends on the catalog: when a model's IDs change
-- (added, removed, renamed, aliases), each policy that names one of them
-- gets a new version, so gateways get its new list in the next sync. A
-- price change allows nothing new and bumps nothing.
CREATE OR REPLACE FUNCTION stratum_catalog_names(provider TEXT, model_id TEXT, aliases TEXT[])
RETURNS TEXT[] LANGUAGE sql IMMUTABLE AS $$
  SELECT ARRAY[model_id] || COALESCE(aliases, '{}')
      || ARRAY(SELECT provider || '/' || n FROM unnest(ARRAY[model_id] || COALESCE(aliases, '{}')) AS n)
$$;

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
     WHERE NOT COALESCE(allow_all_models, false) AND allowed_models && changed;
  END IF;
  RETURN NULL;
END;
$$;

-- One trigger per event: a trigger with transition tables takes only one.
DROP TRIGGER IF EXISTS trg_ai_models_changed ON ai_models;
DROP TRIGGER IF EXISTS trg_ai_models_inserted ON ai_models;
DROP TRIGGER IF EXISTS trg_ai_models_updated ON ai_models;
DROP TRIGGER IF EXISTS trg_ai_models_deleted ON ai_models;
CREATE TRIGGER trg_ai_models_inserted AFTER INSERT ON ai_models
  REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION stratum_catalog_changed();
CREATE TRIGGER trg_ai_models_updated AFTER UPDATE ON ai_models
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION stratum_catalog_changed();
CREATE TRIGGER trg_ai_models_deleted AFTER DELETE ON ai_models
  REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION stratum_catalog_changed();

-- This migration changed the catalog before the triggers existed: every
-- policy that lists models gets a new version once.
UPDATE policies SET updated_at = now()
 WHERE NOT COALESCE(allow_all_models, false) AND cardinality(allowed_models) > 0;

COMMIT;
