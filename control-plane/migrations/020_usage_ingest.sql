-- 020_usage_ingest.sql
--
-- Gateways report each request to POST /api/internal/usage (ADR-0009) and
-- the control plane stores it in request_logs, which the console's usage,
-- spend and log views already read.
--
-- - request_logs.id is the record's ID, chosen by the gateway: a batch sent
--   twice (the answer to the first try was lost) is stored once, because
--   the primary key (id, created_at) rejects the copy.
-- - instance_id: which gateway reported it. request_id: the X-Request-Id
--   the gateway returned to the client, to match a complaint to a row.
-- - data_plane_instances.last_usage_at: last batch received from a gateway.
--
-- Idempotent: safe to run more than once.

BEGIN;

ALTER TABLE request_logs ADD COLUMN IF NOT EXISTS instance_id TEXT;
ALTER TABLE request_logs ADD COLUMN IF NOT EXISTS request_id  TEXT;

ALTER TABLE data_plane_instances ADD COLUMN IF NOT EXISTS last_usage_at TIMESTAMPTZ;

COMMIT;
