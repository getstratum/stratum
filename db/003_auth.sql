-- ============================================================
--  Migration 003 — Password auth for Playground users
-- ============================================================

ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash VARCHAR(255);

-- Index for login lookups
CREATE INDEX IF NOT EXISTS idx_users_email ON users (email) WHERE is_active = true;

-- ─── Test passwords (scrypt: salt:hash) ──────────────────────────────────────
-- dev@acme.com     → password: dev123
-- marketing@acme.com → password: mkt123
--
-- These hashes were generated with Node crypto.scrypt(password, salt, 64)
-- In production, set passwords through the dashboard UI — never in SQL.
--
-- To regenerate:
--   node -e "
--     const c=require('crypto'), s=c.randomBytes(16).toString('hex');
--     c.scrypt('dev123',s,64,(e,k)=>console.log(s+':'+k.toString('hex')))
--   "

UPDATE users
SET password_hash = '4a7d1ed414474e4033ac29ccb8653d9b:b1e4b6f9c3d2a5e8f7a4c9d0b3e6a8f2c5d8e1b4a7c0d3e6f9b2e5a8d1c4f7b0e3a6c9d2f5b8e1a4d7c0f3b6e9a2d5c8f1e4b7a0d3c6f9e2b5a8d1e4b7c0f3'
WHERE email = 'dev@acme.com';

UPDATE users
SET password_hash = '9b2e5a8d1c4f7b0e3a6c9d2f5b8e1a4d:a4c9d0b3e6a8f2c5d8e1b4a7c0d3e6f9b2e5a8d1c4f7b0e3a6c9d2f5b8e1a4d7c0f3b6e9a2d5c8f1e4b7a0d3c6f9e2b5a8d1e4b7c0f3a6c9d2f5b8e1a4d7'
WHERE email = 'marketing@acme.com';

-- NOTE: the hashes above are placeholders — run the seed helper after boot:
--   docker exec -it <proxy-container> node /app/src/seed-passwords.js
