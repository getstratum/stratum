-- 021_agent_model_sync.sql
--
-- An agent's model (agents.default_provider / default_model) reaches the
-- gateways in the sync with its key, and the gateways apply it: every
-- request of that key goes to that model. Changing it has to raise the
-- key's version so the change travels in the next delta.
--
-- Idempotent: safe to run more than once.

BEGIN;

CREATE OR REPLACE FUNCTION stratum_bump_agent_key_version()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.api_key_hash     IS DISTINCT FROM OLD.api_key_hash     OR
     NEW.team_id          IS DISTINCT FROM OLD.team_id          OR
     NEW.is_active        IS DISTINCT FROM OLD.is_active        OR
     NEW.default_provider IS DISTINCT FROM OLD.default_provider OR
     NEW.default_model    IS DISTINCT FROM OLD.default_model
  THEN
    NEW.key_version := nextval('stratum_version_seq');
    IF OLD.api_key_hash IS NOT NULL AND NEW.api_key_hash IS NULL THEN
      NEW.key_revoked_at := now();
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

COMMIT;
