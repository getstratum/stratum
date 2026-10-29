-- 033_app_usage_reports.sql
--
-- An application (OIDC client, 030) may ask the console for usage reports
-- on behalf of a person it signed in: their own usage, and for a team
-- manager their team's, added up with no person apart
-- (GET /api/oidc/usage-report, lib/usage-report.js). Off until an Owner or
-- Admin turns it on for that application in Aplicaciones.

BEGIN;

ALTER TABLE oidc_clients ADD COLUMN IF NOT EXISTS usage_reports BOOLEAN NOT NULL DEFAULT false;

COMMIT;
