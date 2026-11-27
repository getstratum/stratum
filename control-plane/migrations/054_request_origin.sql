-- ============================================================
--  Migration 054 — where a request came from
-- ============================================================
--
-- From 1.0 gateways report each request's origin: the client's address
-- (the connection's, or X-Forwarded-For's from a proxy the gateway trusts)
-- and the User-Agent it sent. Requests shows them, so "where did this come
-- from?" has an answer: a key can be copied, an address and a program say
-- more. A gateway set with STRATUM_RECORD_CLIENT=false sends neither.
--
-- They are personal data for a person's requests: kept as long as the
-- request (the organization's retention), deleted with it.
--
-- Additive.

BEGIN;

ALTER TABLE request_logs ADD COLUMN IF NOT EXISTS client_ip  INET;
ALTER TABLE request_logs ADD COLUMN IF NOT EXISTS user_agent TEXT CHECK (length(user_agent) <= 200);

COMMIT;
