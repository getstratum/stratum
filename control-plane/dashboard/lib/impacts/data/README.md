# EcoLogits data

`models.json` and `electricity_mixes.json` are copied unchanged from
[EcoLogits](https://github.com/mlco2/ecologits) 0.11.3 (GenAI Impact), under
the Mozilla Public License 2.0 (`LICENSE-MPL-2.0`). So is `../ecologits.js`,
a port of its LLM inference model. The rest of Stratum keeps its own license:
the MPL applies file by file.

- `models.json`: parameters (in billions; a range when the lab does not
  publish them) and deployment figures of each model, by provider.
- `electricity_mixes.json`: emissions (kgCO2eq), primary energy (MJ),
  abiotic depletion (kgSbeq) and water (L) per kWh, by country (ISO 3166-1
  alpha-3) and the world average (`WOR`).

## Updating

1. Copy both files from the new EcoLogits release (`ecologits/data/`).
2. Compare `ecologits/impacts/llm.py` and the provider settings in
   `ecologits/tracers/utils.py` with `../ecologits.js`; carry over any change,
   and its `VERSION`.
3. Regenerate the fixtures with that version (`../tools/make-fixtures.py`)
   and run `node --test test/impacts.test.mjs`.

Requests stored before the update keep their estimate and its method
(`impact_method`); new ones get the new one.
