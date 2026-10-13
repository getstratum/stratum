-- ============================================================
--  Migration 007 — Bonsai 27B local provider
-- ============================================================

-- Add Bonsai as a provider pointing to the Ollama service
INSERT INTO providers (slug, display_name, base_url, api_type, api_key_env, is_active, notes)
VALUES (
  'bonsai',
  'Bonsai 8B (local)',
  'http://ollama:11434',
  'openai-compatible',
  'OLLAMA_API_KEY',
  false,
  'PrismML Bonsai 8B — ternary-quantized (~1 GB). Runs fully on-premise via Ollama. No data leaves the network. Enable after downloading the GGUF and creating the model in Ollama.'
)
ON CONFLICT (slug) DO NOTHING;

-- Add Bonsai to the model catalog with $0 cost (local inference)
INSERT INTO ai_models (provider, model_id, display_name, cost_per_1k_input_tokens, cost_per_1k_output_tokens)
VALUES (
  'bonsai',
  'bonsai-8b',
  'Bonsai 8B — local',
  0.000000,
  0.000000
)
ON CONFLICT DO NOTHING;
