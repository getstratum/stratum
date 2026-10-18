-- ============================================================
--  Model catalog: the first prices (USD per 1K tokens).
--  Migration 023 keeps the catalog current.
--
--  Until October 2026 this file also created a demo organization
--  (Acme Corp) with policies, teams and users, so every installation
--  started inside it. That data is in control-plane/seed/demo.sql now,
--  for development and test environments only. Databases created
--  before keep what they have.
-- ============================================================

-- AI Models catalog (prices in USD per 1K tokens)
INSERT INTO ai_models (provider, model_id, display_name, cost_per_1k_input_tokens, cost_per_1k_output_tokens) VALUES
  ('openai',    'gpt-4o',                    'GPT-4o',             0.002500, 0.010000),
  ('openai',    'gpt-4o-mini',               'GPT-4o Mini',        0.000150, 0.000600),
  ('openai',    'o3',                         'o3',                 0.010000, 0.040000),
  ('anthropic', 'claude-sonnet-4-6',          'Claude Sonnet 4.6',  0.003000, 0.015000),
  ('anthropic', 'claude-opus-4-6',            'Claude Opus 4.6',    0.015000, 0.075000),
  ('anthropic', 'claude-haiku-4-5-20251001',  'Claude Haiku 4.5',   0.000800, 0.004000);
