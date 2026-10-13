-- ============================================================
--  Migration 009 — Provider streaming support flag
-- ============================================================
-- Some providers don't support streaming (stream: true).
-- When supports_streaming = false, the proxy forces stream: false.

ALTER TABLE providers ADD COLUMN IF NOT EXISTS supports_streaming BOOLEAN DEFAULT true;
