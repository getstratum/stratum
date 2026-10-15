-- 015_sync_completeness.sql
--
-- Every change that affects what a gateway allows now raises the sync
-- version, so gateways learn about it in the next delta (seconds) instead of
-- the next full resync (up to STRATUM_FULL_RESYNC_INTERVAL, 10 min).
--
-- Before this migration, these reached gateways only through a full resync:
--   - removing a user's key (api_key_hash set to NULL): the row left the
--     delta query and the version watermark;
--   - deactivating a user (is_active = false): the key kept working, even
--     after a full resync;
--   - moving a team to another policy, or removing its policy: teams had no
--     version;
--   - deleting a team, a user or a provider config: rows vanished.
--
-- It adds:
--   1. users: is_active changes bump key_version; removing a key records
--      key_revoked_at, so the sync can send it as a revoked key.
--   2. teams.policy_version, bumped when policy_id changes.
--   3. stratum_sync_tombstones, filled by AFTER DELETE triggers, so deletions
--      travel in deltas and the version never goes backwards.
--   4. stratum_sync_version(org): the version watermark for one
--      organisation, covering all of the above.
--
-- Idempotent: safe to run more than once.

BEGIN;

-- 1. Users ------------------------------------------------------------------

CREATE OR REPLACE FUNCTION stratum_bump_key_version()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.api_key_hash IS DISTINCT FROM OLD.api_key_hash OR
     NEW.key_revoked  IS DISTINCT FROM OLD.key_revoked  OR
     NEW.team_id      IS DISTINCT FROM OLD.team_id      OR
     NEW.is_active    IS DISTINCT FROM OLD.is_active
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

CREATE INDEX IF NOT EXISTS idx_users_org_key_version ON users (org_id, key_version);

-- 2. Teams ------------------------------------------------------------------

ALTER TABLE teams ADD COLUMN IF NOT EXISTS policy_version BIGINT NOT NULL DEFAULT nextval('stratum_version_seq');

CREATE OR REPLACE FUNCTION stratum_bump_team_policy_version()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.policy_id IS DISTINCT FROM OLD.policy_id THEN
    NEW.policy_version := nextval('stratum_version_seq');
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_teams_policy_version ON teams;
CREATE TRIGGER trg_teams_policy_version
  BEFORE UPDATE ON teams
  FOR EACH ROW
  EXECUTE FUNCTION stratum_bump_team_policy_version();

CREATE INDEX IF NOT EXISTS idx_teams_org_policy_version ON teams (org_id, policy_version);

-- 3. Tombstones ---------------------------------------------------------------

CREATE TABLE IF NOT EXISTS stratum_sync_tombstones (
  version    BIGINT      PRIMARY KEY DEFAULT nextval('stratum_version_seq'),
  -- No foreign key: deleting an organisation cascades to its teams and
  -- users, whose triggers write here while the organisation row is going.
  org_id     UUID        NOT NULL,
  kind       TEXT        NOT NULL CHECK (kind IN ('api_key', 'team', 'provider_config', 'policy')),
  object_id  TEXT        NOT NULL,
  provider   TEXT,                                -- provider_config only
  deleted_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sync_tombstones_org_version ON stratum_sync_tombstones (org_id, version);

CREATE OR REPLACE FUNCTION stratum_record_tombstone()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'users' THEN
    -- Every deleted user, key or not: the user's key_version counted in the
    -- watermark, and a key removed just before the deletion must still
    -- reach gateways as revoked. For an id a gateway never had, it is an
    -- inert revoked entry.
    INSERT INTO stratum_sync_tombstones (org_id, kind, object_id)
    VALUES (OLD.org_id, 'api_key', OLD.id::text);
  ELSIF TG_TABLE_NAME = 'teams' THEN
    INSERT INTO stratum_sync_tombstones (org_id, kind, object_id)
    VALUES (OLD.org_id, 'team', OLD.id::text);
  ELSIF TG_TABLE_NAME = 'provider_configs' THEN
    INSERT INTO stratum_sync_tombstones (org_id, kind, object_id, provider)
    VALUES (OLD.org_id, 'provider_config', OLD.id::text, OLD.provider);
  ELSIF TG_TABLE_NAME = 'policies' THEN
    -- Gateways key policies by team, so a deleted policy needs no message;
    -- the tombstone keeps the version watermark from going backwards.
    INSERT INTO stratum_sync_tombstones (org_id, kind, object_id)
    VALUES (OLD.org_id, 'policy', OLD.id::text);
  END IF;
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS trg_users_tombstone ON users;
CREATE TRIGGER trg_users_tombstone AFTER DELETE ON users
  FOR EACH ROW EXECUTE FUNCTION stratum_record_tombstone();

DROP TRIGGER IF EXISTS trg_teams_tombstone ON teams;
CREATE TRIGGER trg_teams_tombstone AFTER DELETE ON teams
  FOR EACH ROW EXECUTE FUNCTION stratum_record_tombstone();

DROP TRIGGER IF EXISTS trg_provider_configs_tombstone ON provider_configs;
CREATE TRIGGER trg_provider_configs_tombstone AFTER DELETE ON provider_configs
  FOR EACH ROW EXECUTE FUNCTION stratum_record_tombstone();

DROP TRIGGER IF EXISTS trg_policies_tombstone ON policies;
CREATE TRIGGER trg_policies_tombstone AFTER DELETE ON policies
  FOR EACH ROW EXECUTE FUNCTION stratum_record_tombstone();

-- 4. Version watermark --------------------------------------------------------
--
-- Per organisation: a change in one organisation no longer moves the version
-- every other organisation's gateways see. Removed keys and tombstones count,
-- so the watermark does not go backwards when something is removed.

CREATE OR REPLACE FUNCTION stratum_sync_version(p_org UUID)
RETURNS BIGINT LANGUAGE sql STABLE AS $$
  SELECT GREATEST(
    COALESCE((SELECT MAX(version)        FROM policies                WHERE org_id = p_org), 0),
    COALESCE((SELECT MAX(policy_version) FROM teams                   WHERE org_id = p_org), 0),
    COALESCE((SELECT MAX(key_version)    FROM users                   WHERE org_id = p_org), 0),
    COALESCE((SELECT MAX(version)        FROM provider_configs        WHERE org_id = p_org), 0),
    COALESCE((SELECT MAX(version)        FROM stratum_sync_tombstones WHERE org_id = p_org), 0)
  )
$$;

COMMIT;
