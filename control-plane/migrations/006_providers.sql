-- ============================================================
--  Migration 006 — Provider management
-- ============================================================

CREATE TABLE IF NOT EXISTS providers (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug         VARCHAR(50) UNIQUE NOT NULL,
  display_name VARCHAR(100) NOT NULL,
  base_url     VARCHAR(500) NOT NULL,
  api_type     VARCHAR(50) NOT NULL DEFAULT 'openai-compatible',
  -- 'openai-compatible' | 'anthropic' | 'aws-bedrock' | 'google-vertex'
  api_key_env  VARCHAR(100) NOT NULL,  -- name of the env var holding the key
  auth_header  VARCHAR(100),           -- e.g. 'x-api-key' for Anthropic
  is_active    BOOLEAN DEFAULT true,
  notes        TEXT,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

-- Seed: current providers (active)
INSERT INTO providers (slug, display_name, base_url, api_type, api_key_env, auth_header, is_active, notes)
VALUES
  ('openai',
   'OpenAI',
   'https://api.openai.com',
   'openai-compatible',
   'OPENAI_API_KEY',
   NULL,
   true,
   'Supports GPT-4o, GPT-4o-mini, o3 and other OpenAI models.'),

  ('anthropic',
   'Anthropic',
   'https://api.anthropic.com',
   'anthropic',
   'ANTHROPIC_API_KEY',
   'x-api-key',
   true,
   'Supports Claude Sonnet, Opus and Haiku models. Requires anthropic-version header.')

ON CONFLICT (slug) DO NOTHING;

-- Seed: future providers (inactive — ready to enable once API keys are set)
INSERT INTO providers (slug, display_name, base_url, api_type, api_key_env, is_active, notes)
VALUES
  ('azure-openai',
   'Azure OpenAI',
   'https://{resource}.openai.azure.com/openai',
   'openai-compatible',
   'AZURE_OPENAI_API_KEY',
   false,
   'OpenAI models deployed on Azure. Set base_url to your Azure endpoint. Compliant with Azure data residency.'),

  ('google-gemini',
   'Google Gemini',
   'https://generativelanguage.googleapis.com/v1beta/openai',
   'openai-compatible',
   'GEMINI_API_KEY',
   false,
   'Gemini models via OpenAI-compatible endpoint. Requires GEMINI_API_KEY.'),

  ('aws-bedrock',
   'AWS Bedrock',
   'https://bedrock-runtime.{region}.amazonaws.com',
   'aws-bedrock',
   'AWS_ACCESS_KEY_ID',
   false,
   'AWS managed AI models (Claude, Llama, Titan). Requires AWS credentials and IAM role. Not yet implemented.'),

  ('groq',
   'Groq',
   'https://api.groq.com/openai',
   'openai-compatible',
   'GROQ_API_KEY',
   false,
   'Ultra-fast inference via Groq LPU. OpenAI-compatible API. Supports Llama, Mistral and Gemma.'),

  ('ollama',
   'Ollama (local)',
   'http://ollama:11434',
   'openai-compatible',
   'OLLAMA_API_KEY',
   false,
   'Local models via Ollama. Set base_url to your Ollama instance. No API key required — set OLLAMA_API_KEY to any value.')

ON CONFLICT (slug) DO NOTHING;

-- Gemini 3.x models (current as of August 2026 — 1.x and 2.x shut down)
INSERT INTO ai_models (provider, model_id, display_name, cost_per_1k_input_tokens, cost_per_1k_output_tokens)
VALUES
  ('google-gemini', 'gemini-3.6-flash',      'Gemini 3.6 Flash',      0.001500, 0.007500),
  ('google-gemini', 'gemini-3.5-flash',      'Gemini 3.5 Flash',      0.000750, 0.004500),
  ('google-gemini', 'gemini-3.5-flash-lite', 'Gemini 3.5 Flash-Lite', 0.000300, 0.002500),
ON CONFLICT DO NOTHING;
