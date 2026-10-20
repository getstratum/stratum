-- 028_delegation_and_people.sql
--
-- Keys that act on behalf of people, for applications built on the
-- gateway (a chat portal, an internal assistant):
--
-- 1. agents.delegates: an agent whose key may send X-Stratum-User. The
--    gateway then applies that person's team policy and reports the usage
--    as theirs. Off for every existing agent. It changes what the key can
--    do, so it raises the key's version like its model does (021).
-- 2. users.app_access: whether a person may use such applications. On by
--    default; turning it off is how the console takes someone out of every
--    application at once, within one sync interval.
-- 3. The people directory in the sync: every person's id, team and whether
--    applications may act for them, so a gateway resolves X-Stratum-User
--    without asking the control plane. It reuses users.key_version, which
--    already changes with team_id and is_active, and now with app_access.
--    A deleted person reaches gateways as a 'person' tombstone.
--
-- Idempotent: safe to run more than once.

BEGIN;

ALTER TABLE agents ADD COLUMN IF NOT EXISTS delegates  BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE users  ADD COLUMN IF NOT EXISTS app_access BOOLEAN NOT NULL DEFAULT true;

CREATE OR REPLACE FUNCTION stratum_bump_agent_key_version()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.api_key_hash     IS DISTINCT FROM OLD.api_key_hash     OR
     NEW.team_id          IS DISTINCT FROM OLD.team_id          OR
     NEW.is_active        IS DISTINCT FROM OLD.is_active        OR
     NEW.default_provider IS DISTINCT FROM OLD.default_provider OR
     NEW.default_model    IS DISTINCT FROM OLD.default_model    OR
     NEW.delegates        IS DISTINCT FROM OLD.delegates
  THEN
    NEW.key_version := nextval('stratum_version_seq');
    IF OLD.api_key_hash IS NOT NULL AND NEW.api_key_hash IS NULL THEN
      NEW.key_revoked_at := now();
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION stratum_bump_key_version()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.api_key_hash IS DISTINCT FROM OLD.api_key_hash OR
     NEW.key_revoked  IS DISTINCT FROM OLD.key_revoked  OR
     NEW.team_id      IS DISTINCT FROM OLD.team_id      OR
     NEW.is_active    IS DISTINCT FROM OLD.is_active    OR
     NEW.app_access   IS DISTINCT FROM OLD.app_access
  THEN
    NEW.key_version := nextval('stratum_version_seq');
    -- A removed key must reach gateways as a revocation, not just vanish.
    IF OLD.api_key_hash IS NOT NULL AND NEW.api_key_hash IS NULL THEN
      NEW.key_revoked_at := now();
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

ALTER TABLE stratum_sync_tombstones DROP CONSTRAINT IF EXISTS stratum_sync_tombstones_kind_check;
ALTER TABLE stratum_sync_tombstones ADD CONSTRAINT stratum_sync_tombstones_kind_check
  CHECK (kind IN ('api_key', 'team', 'provider_config', 'policy', 'person'));

-- 017's function, plus a 'person' tombstone for a deleted user.
CREATE OR REPLACE FUNCTION stratum_record_tombstone()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'users' THEN
    INSERT INTO stratum_sync_tombstones (org_id, kind, object_id)
    VALUES (OLD.org_id, 'api_key', OLD.id::text),
           (OLD.org_id, 'person',  OLD.id::text);
  ELSIF TG_TABLE_NAME = 'agents' THEN
    INSERT INTO stratum_sync_tombstones (org_id, kind, object_id)
    VALUES (OLD.org_id, 'api_key', 'agent:' || OLD.id::text);
  ELSIF TG_TABLE_NAME = 'teams' THEN
    INSERT INTO stratum_sync_tombstones (org_id, kind, object_id)
    VALUES (OLD.org_id, 'team', OLD.id::text);
  ELSIF TG_TABLE_NAME = 'provider_configs' THEN
    INSERT INTO stratum_sync_tombstones (org_id, kind, object_id, provider)
    VALUES (OLD.org_id, 'provider_config', OLD.id::text, OLD.provider);
  ELSIF TG_TABLE_NAME = 'policies' THEN
    INSERT INTO stratum_sync_tombstones (org_id, kind, object_id)
    VALUES (OLD.org_id, 'policy', OLD.id::text);
  END IF;
  RETURN OLD;
END;
$$;

COMMIT;
