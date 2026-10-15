-- 017_agent_keys_sync.sql
--
-- Agent keys reach gateways. Agents (004_agents.sql) had API keys that the
-- console created and showed, but the sync never sent them, so a gateway
-- refused every agent key. They now travel like user keys (015): versioned,
-- revoked explicitly when they stop working, and as tombstones when the
-- agent is deleted. In the sync their id is "agent:<uuid>", so they never
-- collide with a user's key.
--
-- Idempotent: safe to run more than once.

BEGIN;

-- Each existing row gets its own version (a volatile default is evaluated
-- per row).
ALTER TABLE agents ADD COLUMN IF NOT EXISTS key_version    BIGINT      NOT NULL DEFAULT nextval('stratum_version_seq');
ALTER TABLE agents ADD COLUMN IF NOT EXISTS key_revoked_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_agents_org_key_version ON agents (org_id, key_version);

CREATE OR REPLACE FUNCTION stratum_bump_agent_key_version()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.api_key_hash IS DISTINCT FROM OLD.api_key_hash OR
     NEW.team_id      IS DISTINCT FROM OLD.team_id      OR
     NEW.is_active    IS DISTINCT FROM OLD.is_active
  THEN
    NEW.key_version := nextval('stratum_version_seq');
    IF OLD.api_key_hash IS NOT NULL AND NEW.api_key_hash IS NULL THEN
      NEW.key_revoked_at := now();
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_agents_key_version ON agents;
CREATE TRIGGER trg_agents_key_version
  BEFORE UPDATE ON agents
  FOR EACH ROW EXECUTE FUNCTION stratum_bump_agent_key_version();

-- Tombstones: 015's function, plus deleted agents.
CREATE OR REPLACE FUNCTION stratum_record_tombstone()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'users' THEN
    INSERT INTO stratum_sync_tombstones (org_id, kind, object_id)
    VALUES (OLD.org_id, 'api_key', OLD.id::text);
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

DROP TRIGGER IF EXISTS trg_agents_tombstone ON agents;
CREATE TRIGGER trg_agents_tombstone AFTER DELETE ON agents
  FOR EACH ROW EXECUTE FUNCTION stratum_record_tombstone();

-- The watermark covers agent keys too.
CREATE OR REPLACE FUNCTION stratum_sync_version(p_org UUID)
RETURNS BIGINT LANGUAGE sql STABLE AS $$
  SELECT GREATEST(
    COALESCE((SELECT MAX(version)        FROM policies                WHERE org_id = p_org), 0),
    COALESCE((SELECT MAX(policy_version) FROM teams                   WHERE org_id = p_org), 0),
    COALESCE((SELECT MAX(key_version)    FROM users                   WHERE org_id = p_org), 0),
    COALESCE((SELECT MAX(key_version)    FROM agents                  WHERE org_id = p_org), 0),
    COALESCE((SELECT MAX(version)        FROM provider_configs        WHERE org_id = p_org), 0),
    COALESCE((SELECT MAX(version)        FROM stratum_sync_tombstones WHERE org_id = p_org), 0)
  )
$$;

COMMIT;
