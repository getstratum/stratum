-- ============================================================
--  Migration 010 — PII/DLP columns
-- ============================================================
-- Adds the columns Stratum Enterprise Gateway (Go) needs to read/write
-- when pointed at this same Postgres database: per-policy PII scanning
-- configuration, and per-request PII flags in the log.
--
-- request_logs is partitioned by month — add the columns to the PARENT
-- table only. PostgreSQL propagates the change to all existing and future
-- partitions automatically; an explicit ALTER on a partition itself fails
-- with "cannot add column to a partition".

ALTER TABLE request_logs ADD COLUMN IF NOT EXISTS pii_flagged BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE request_logs ADD COLUMN IF NOT EXISTS pii_types   TEXT[]  NOT NULL DEFAULT '{}';

ALTER TABLE policies ADD COLUMN IF NOT EXISTS pii_action VARCHAR(20) NOT NULL DEFAULT 'off';  -- off | log | redact | block
ALTER TABLE policies ADD COLUMN IF NOT EXISTS pii_types  TEXT[]      NOT NULL DEFAULT '{}';    -- email, phone, credit_card, ssn, ci_uy, ip_address, api_key

CREATE INDEX IF NOT EXISTS idx_rl_pii_flagged ON request_logs (pii_flagged) WHERE pii_flagged = true;
