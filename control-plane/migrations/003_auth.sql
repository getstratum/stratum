-- ============================================================
--  Migration 003 — password column for console sign-in
-- ============================================================
--
-- Until October 2026 this file also set placeholder passwords for the demo
-- users; migration 016 clears them on databases that still have them.

ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash VARCHAR(255);

-- Index for login lookups
CREATE INDEX IF NOT EXISTS idx_users_email ON users (email) WHERE is_active = true;
