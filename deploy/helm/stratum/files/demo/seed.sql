-- ============================================================
--  Demo data, for development and test environments only.
--
--  A new installation starts empty: its first account is created with
--    stratum-admin create-owner --email ... --org-name "..."
--  This file instead gives a fixed organization to build on, used by the
--  console's functional test (control-plane/e2e/run-local.sh) and the GCP
--  test kit (deploy/gcp):
--
--    Acme Corp (Demo)   00000000-0000-0000-0000-000000000001
--      Engineering      team 20000000-…-0001, policy "Engineering Policy"
--      Marketing        team 20000000-…-0002, policy "Marketing Policy"
--      dev@acme.com, marketing@acme.com   members, no password, no key
--
--  Apply after the migrations; running it again changes nothing:
--    psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -f control-plane/seed/demo.sql
-- ============================================================

BEGIN;

INSERT INTO organizations (id, name, domain, plan_tier) VALUES
  ('00000000-0000-0000-0000-000000000001', 'Acme Corp (Demo)', 'acme.com', 'professional')
ON CONFLICT DO NOTHING;

INSERT INTO policies (id, org_id, name, allowed_models, max_tokens_per_request, monthly_token_quota, monthly_budget_usd) VALUES
  ('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001', 'Engineering Policy',
   ARRAY['gpt-4o', 'gpt-4o-mini', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001'], 8192, 5000000, 500.00),
  ('10000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000001', 'Marketing Policy',
   ARRAY['gpt-4o-mini', 'claude-haiku-4-5-20251001'], 2048, 500000, 50.00)
ON CONFLICT DO NOTHING;

INSERT INTO teams (id, org_id, policy_id, name, department, monthly_budget_usd) VALUES
  ('20000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001',
   '10000000-0000-0000-0000-000000000001', 'Engineering', 'Tech', 500.00),
  ('20000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000001',
   '10000000-0000-0000-0000-000000000002', 'Marketing', 'Growth', 50.00)
ON CONFLICT DO NOTHING;

INSERT INTO users (id, org_id, team_id, email, name, role) VALUES
  ('30000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001',
   '20000000-0000-0000-0000-000000000001', 'dev@acme.com', 'Dev User', 'member'),
  ('30000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000001',
   '20000000-0000-0000-0000-000000000002', 'marketing@acme.com', 'Marketing User', 'member')
ON CONFLICT DO NOTHING;

COMMIT;
