-- ============================================================
--  Migration 052 — the prompt cache, counted and priced
-- ============================================================
--
-- Providers cache a long prompt (a document, a corpus, instructions) and
-- charge for it apart: Anthropic, a write at 1.25 times the input price and
-- a read at a tenth; OpenAI, a read at a discount. Gateways before 1.0 did
-- not see Anthropic's cache tokens at all, so a request that wrote 87,000
-- tokens to the cache was counted as a dozen.
--
-- From 1.0 gateways report them: tokens_input counts every input token, as
-- the providers' usage pages do, and these two say which part of it was
-- written to or read from the cache, so it is priced as such.
--
-- Prices: the catalog's and the organization's own, per 1,000 tokens as the
-- others. NULL: Anthropic's multipliers on the input price (1.25 and 0.1),
-- and for any other provider the input price.
--
-- Additive.

BEGIN;

ALTER TABLE request_logs ADD COLUMN IF NOT EXISTS tokens_cache_write INTEGER CHECK (tokens_cache_write >= 0);
ALTER TABLE request_logs ADD COLUMN IF NOT EXISTS tokens_cache_read  INTEGER CHECK (tokens_cache_read >= 0);

ALTER TABLE ai_models ADD COLUMN IF NOT EXISTS cost_per_1k_cache_write_tokens NUMERIC(10,6) CHECK (cost_per_1k_cache_write_tokens >= 0);
ALTER TABLE ai_models ADD COLUMN IF NOT EXISTS cost_per_1k_cache_read_tokens  NUMERIC(10,6) CHECK (cost_per_1k_cache_read_tokens >= 0);
ALTER TABLE org_model_settings ADD COLUMN IF NOT EXISTS cost_per_1k_cache_write_tokens NUMERIC(10,6) CHECK (cost_per_1k_cache_write_tokens >= 0);
ALTER TABLE org_model_settings ADD COLUMN IF NOT EXISTS cost_per_1k_cache_read_tokens  NUMERIC(10,6) CHECK (cost_per_1k_cache_read_tokens >= 0);

COMMIT;
