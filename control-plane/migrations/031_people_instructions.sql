-- 031_people_instructions.sql
--
-- Instructions for people: a text in the policy that gateways (from 0.3)
-- put first in the system instruction of the requests an application makes
-- for a person (X-Stratum-User), for example "when context is missing, ask
-- before answering". Never in an agent's or a key's own requests. The
-- gateway returns it to the application (GET /v1/stratum/instructions), so
-- people can see it. Changing it bumps the policy's version (migration 012),
-- so it reaches gateways with the next sync, and the console audits it.
--
-- Idempotent: safe to run more than once.

BEGIN;

ALTER TABLE policies ADD COLUMN IF NOT EXISTS people_instructions TEXT;

DO $$ BEGIN
  ALTER TABLE policies ADD CONSTRAINT policies_people_instructions_len
    CHECK (people_instructions IS NULL OR char_length(people_instructions) BETWEEN 1 AND 2000);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

COMMIT;
