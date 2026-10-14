-- Test-environment bootstrap, run once after migrations by scripts/deploy.sh.
-- Variables (psql -v): eng_hash, mkt_hash = SHA-256 of freshly generated keys.
--
-- 1. The seed migration ships demo users whose API keys are published in the
--    repository. On an internet-facing environment they must not work:
--    replace them with random keys that only exist in Secret Manager.
-- 2. Policies for the test plan: Engineering may use the mock model with a
--    large quota (load tests); Marketing has a small quota (shared quota
--    test: 30 requests of 100 tokens).
\set ON_ERROR_STOP on

BEGIN;

UPDATE users SET api_key_hash = :'eng_hash', api_key_prefix = 'sk-stratum-'
 WHERE email = 'dev@acme.com';
UPDATE users SET api_key_hash = :'mkt_hash', api_key_prefix = 'sk-stratum-'
 WHERE email = 'marketing@acme.com';

-- Any other user keeps no usable key.
UPDATE users SET api_key_hash = encode(sha256(gen_random_uuid()::text::bytea), 'hex')
 WHERE email NOT IN ('dev@acme.com', 'marketing@acme.com');

UPDATE policies
   SET allow_all_models    = true,
       monthly_token_quota = 1000000000,
       allowed_providers   = NULL
 WHERE name = 'Engineering Policy';

UPDATE policies
   SET allowed_models      = array_append(array_remove(allowed_models, 'mock-1'), 'mock-1'),
       monthly_token_quota = 3000,
       allowed_providers   = NULL
 WHERE name = 'Marketing Policy';

COMMIT;

SELECT email, api_key_prefix FROM users ORDER BY email;
SELECT name, allow_all_models, monthly_token_quota FROM policies ORDER BY name;
