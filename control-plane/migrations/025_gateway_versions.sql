-- ============================================================
--  Migration 025 — which gateway versions are syncing
-- ============================================================
--
-- One registered gateway is often several processes (the replicas of a
-- Helm release share its sync token), and during an upgrade they run
-- different versions. Each sync records the version in its User-Agent
-- (stratum-gateway/<version>) with the time it was seen; entries older than
-- 15 minutes are dropped on the next sync. The console shows the versions
-- seen recently, and warns when one predates a feature that the gateways
-- enforce (models turned off for the organization need 0.2.0).
--
-- Additive: a console of the previous release ignores the column.

BEGIN;

ALTER TABLE data_plane_instances
  ADD COLUMN IF NOT EXISTS gateway_versions JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMIT;
