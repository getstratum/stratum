-- ============================================================
--  Migration 050 — what an organization's plan includes (ADR-0020)
-- ============================================================
--
-- organizations.features: the paid functions the organization's plan
-- includes ('portal', 'agent_guard', 'history_audit', ...), which the
-- Enterprise portal and guard read from the console
-- (GET /api/oidc/entitlements). NULL is not managed: the organization has
-- whatever the installation's license includes, as until now.
--
-- The installation keeps one signed license (Enterprise's licensing/);
-- whoever runs it splits it among organizations through their plans, here
-- and in limits.portal_seats. The console does not know what each feature
-- does: names only.
--
-- Additive.

BEGIN;

ALTER TABLE organizations ADD COLUMN IF NOT EXISTS features TEXT[];
ALTER TABLE organizations DROP CONSTRAINT IF EXISTS organizations_features_names;
ALTER TABLE organizations ADD CONSTRAINT organizations_features_names
  CHECK (features IS NULL OR (cardinality(features) <= 20
         AND array_to_string(features, ',') ~ '^([a-z_]{1,40}(,[a-z_]{1,40})*)?$'));

COMMIT;
