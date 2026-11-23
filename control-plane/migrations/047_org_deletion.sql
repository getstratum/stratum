-- ============================================================
--  Migration 047 — deleting an organization in two steps (ADR-0020)
-- ============================================================
--
-- 1. organizations.delete_after: an organization marked for deletion is
--    suspended and keeps everything until then, so whoever runs the
--    installation can undo it (30 days). status_before_delete is what undo
--    goes back to. After delete_after, the daily maintenance deletes all of
--    it (lib/org-deletion.js).
-- 2. platform_audit: what is done to organizations from outside them
--    (stratum-admin today, the platform API and stratum-operator later).
--    It outlives the organizations it talks about: no foreign keys.
--    Append-only, like audit_log.
-- 3. audit_log stays append-only, with one exception: the rows of an
--    organization whose deletion is due, which go with the rest of its data.
--    Its existence and who deleted it stay in platform_audit.
--
-- Additive for the previous console: it neither reads nor writes the new
-- column or table, and nothing it does deletes audit rows.

BEGIN;

ALTER TABLE organizations ADD COLUMN IF NOT EXISTS delete_after TIMESTAMPTZ;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS status_before_delete TEXT;

CREATE TABLE IF NOT EXISTS platform_audit (
  id          BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor       TEXT        NOT NULL,   -- 'stratum-admin (CLI)', 'maintenance', ...
  action      TEXT        NOT NULL,   -- org.suspend, org.limits, org.delete, org.purge, ...
  org_id      UUID,                   -- no foreign key: the record outlives it
  org_name    TEXT,
  details     JSONB       NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_platform_audit_at  ON platform_audit (at DESC);
CREATE INDEX IF NOT EXISTS idx_platform_audit_org ON platform_audit (org_id, at DESC);

DROP TRIGGER IF EXISTS trg_platform_audit_append_only ON platform_audit;
CREATE TRIGGER trg_platform_audit_append_only
  BEFORE UPDATE OR DELETE ON platform_audit
  FOR EACH ROW EXECUTE FUNCTION stratum_audit_log_append_only();

-- The function is shared with platform_audit, whose rows have no
-- delete_after to point at: TG_TABLE_NAME keeps the exception to audit_log.
CREATE OR REPLACE FUNCTION stratum_audit_log_append_only()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND TG_TABLE_NAME = 'audit_log' AND OLD.org_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM organizations o
                  WHERE o.id = OLD.org_id AND o.delete_after IS NOT NULL AND o.delete_after <= now()) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END;
$$;

COMMIT;
