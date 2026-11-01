-- 035_app_history_audit.sql
--
-- An application that keeps people's conversations (a chat portal) may ask
-- the console who audits and who may approve an audit, look up the people
-- of the organization, and record in the audit log every request,
-- approval, refusal, revocation and reading of someone's history
-- (/api/oidc/history-audit, lib/history-audit.js). The conversations stay
-- in the application: the console never sees them. Off until an Owner or
-- Admin turns it on for that application in Aplicaciones.

BEGIN;

ALTER TABLE oidc_clients ADD COLUMN IF NOT EXISTS history_audit BOOLEAN NOT NULL DEFAULT false;

COMMIT;
