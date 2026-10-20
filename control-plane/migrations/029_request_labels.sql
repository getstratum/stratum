-- 029_request_labels.sql
--
-- Labels an application puts on its requests (X-Stratum-Labels on the
-- gateway, "labels" in api/usage/v1): a chat portal tags each request with
-- its topic, an agent with the feature that made it. They are the
-- application's words, kept apart from content_flags (pii_types), which
-- only the gateway's own scanners set, so a label never counts as a PII
-- finding. Consumo groups by them.
--
-- Idempotent: safe to run more than once.

BEGIN;

ALTER TABLE request_logs ADD COLUMN IF NOT EXISTS labels TEXT[] NOT NULL DEFAULT '{}';

COMMIT;
