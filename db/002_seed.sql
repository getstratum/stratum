-- ============================================================
--  AI Governance MVP — Seed Data (dev/demo only)
-- ============================================================

-- Demo Organization
INSERT INTO organizations (id, name, domain, plan_tier) VALUES
  ('00000000-0000-0000-0000-000000000001', 'Acme Corp (Demo)', 'acme.com', 'professional');

-- Policies
INSERT INTO policies (id, org_id, name, allowed_models, max_tokens_per_request, monthly_token_quota, monthly_budget_usd) VALUES
  (
    '10000000-0000-0000-0000-000000000001',
    '00000000-0000-0000-0000-000000000001',
    'Engineering Policy',
    ARRAY['gpt-4o', 'gpt-4o-mini', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001'],
    8192, 5000000, 500.00
  ),
  (
    '10000000-0000-0000-0000-000000000002',
    '00000000-0000-0000-0000-000000000001',
    'Marketing Policy',
    ARRAY['gpt-4o-mini', 'claude-haiku-4-5-20251001'],
    2048, 500000, 50.00
  );

-- Teams
INSERT INTO teams (id, org_id, policy_id, name, department, monthly_budget_usd) VALUES
  (
    '20000000-0000-0000-0000-000000000001',
    '00000000-0000-0000-0000-000000000001',
    '10000000-0000-0000-0000-000000000001',
    'Engineering', 'Tech', 500.00
  ),
  (
    '20000000-0000-0000-0000-000000000002',
    '00000000-0000-0000-0000-000000000001',
    '10000000-0000-0000-0000-000000000002',
    'Marketing', 'Growth', 50.00
  );

-- Users
-- api_key_hash = SHA256 of the raw key (computed externally, stored here)
--   Engineering key : aig_sk_eng_test1234567890
--   Marketing key   : aig_sk_mkt_test1234567890
INSERT INTO users (id, org_id, team_id, email, name, role, api_key_hash, api_key_prefix) VALUES
  (
    '30000000-0000-0000-0000-000000000001',
    '00000000-0000-0000-0000-000000000001',
    '20000000-0000-0000-0000-000000000001',
    'dev@acme.com', 'Dev User', 'user',
    '3ba6ea2bd037fee129f1115ad2361d4692aa55d0c3e530fa5b82622792943d1f',
    'aig_sk_eng_'
  ),
  (
    '30000000-0000-0000-0000-000000000002',
    '00000000-0000-0000-0000-000000000001',
    '20000000-0000-0000-0000-000000000002',
    'marketing@acme.com', 'Marketing User', 'user',
    'ff27ac1cbcd92ed9676d1d5002561bb09eda9a7259ddb7b89aeeb15b24a96cc2',
    'aig_sk_mkt_'
  );

-- AI Models catalog (prices in USD per 1K tokens)
INSERT INTO ai_models (provider, model_id, display_name, cost_per_1k_input_tokens, cost_per_1k_output_tokens) VALUES
  ('openai',    'gpt-4o',                    'GPT-4o',             0.002500, 0.010000),
  ('openai',    'gpt-4o-mini',               'GPT-4o Mini',        0.000150, 0.000600),
  ('openai',    'o3',                         'o3',                 0.010000, 0.040000),
  ('anthropic', 'claude-sonnet-4-6',          'Claude Sonnet 4.6',  0.003000, 0.015000),
  ('anthropic', 'claude-opus-4-6',            'Claude Opus 4.6',    0.015000, 0.075000),
  ('anthropic', 'claude-haiku-4-5-20251001',  'Claude Haiku 4.5',   0.000800, 0.004000);
