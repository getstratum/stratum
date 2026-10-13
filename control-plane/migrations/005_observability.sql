-- ============================================================
--  Migration 005 — Observability: per-stage timing + trace ID
-- ============================================================

-- Add columns to the parent table only — Postgres propagates to all partitions automatically
ALTER TABLE request_logs ADD COLUMN IF NOT EXISTS trace_id    UUID DEFAULT gen_random_uuid();
ALTER TABLE request_logs ADD COLUMN IF NOT EXISTS auth_ms     INTEGER;
ALTER TABLE request_logs ADD COLUMN IF NOT EXISTS policy_ms   INTEGER;
ALTER TABLE request_logs ADD COLUMN IF NOT EXISTS provider_ms INTEGER;
