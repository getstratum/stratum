"""
Expected impacts from the EcoLogits Python library, for test/impacts.test.mjs.

  python -m venv /tmp/eco && /tmp/eco/bin/pip install ecologits==0.11.3
  /tmp/eco/bin/python lib/impacts/tools/make-fixtures.py > test/fixtures/ecologits-0.11.3.json

When updating EcoLogits: copy its data/models.json and data/electricity_mixes.json
to lib/impacts/data, update the constants in lib/impacts/ecologits.js if they
changed, and regenerate this file with the same version.
"""
import json
import sys

import ecologits
from ecologits.tracers.utils import llm_impacts

# (Stratum provider, Stratum model ID, EcoLogits provider, EcoLogits model, output tokens, latency s)
CASES = [
    ("openai", "gpt-4o-mini", "openai", "gpt-4o-mini", 400, 6.0),           # dense range, tps
    ("openai", "gpt-4o-mini", "openai", "gpt-4o-mini", 400, 0.8),           # latency capped by the request's
    ("azure", "gpt-4o-mini-2024-07-18", "openai", "gpt-4o-mini-2024-07-18", 120, 2.5),
    ("anthropic", "claude-sonnet-4-5", "anthropic", "claude-sonnet-4-5", 800, 20.0),  # MoE, alias, PUE range
    ("anthropic", "claude-haiku-4-5-20251001", "anthropic", "claude-haiku-4-5-20251001", 50, 1.2),
    ("gemini", "gemini-2.5-pro", "google_genai", "gemini-2.5-pro", 1500, 30.0),
    ("mistral", "mistral-large-latest", "mistralai", "mistral-large-latest", 300, 7.0),  # SWE mix
    ("mistral", "codestral-latest", "mistralai", "codestral-latest", 300, 7.0),          # no tps: regression
    ("openrouter", "openai/gpt-5-mini", "openai", "gpt-5-mini", 900, 15.0),
    ("groq", "meta-llama/Meta-Llama-3.1-8B-Instruct", "huggingface_hub", "meta-llama/Meta-Llama-3.1-8B-Instruct", 200, 1.0),
]

out = {"ecologits": ecologits.__version__, "cases": []}
for sp, sm, ep, em, tokens, latency in CASES:
    r = llm_impacts(provider=ep, model_name=em, output_token_count=tokens, request_latency=latency)
    if r.has_errors:
        sys.exit(f"{ep}/{em}: {r.errors}")

    def rng(v):
        v = v.value
        return {"min": v.min, "max": v.max} if hasattr(v, "min") else {"min": v, "max": v}

    out["cases"].append({
        "provider": sp, "model": sm, "tokens_out": tokens, "duration_ms": int(latency * 1000),
        "expected": {"energy_kwh": rng(r.energy), "gwp_kg": rng(r.gwp), "adpe_kgsb": rng(r.adpe),
                     "pe_mj": rng(r.pe), "wcf_l": rng(r.wcf)},
    })
json.dump(out, sys.stdout, indent=1)
print()
