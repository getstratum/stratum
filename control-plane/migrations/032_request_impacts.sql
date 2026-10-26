-- 032_request_impacts.sql
--
-- The estimated environmental impact of each request, computed by the
-- console when a gateway reports its usage (lib/impacts: the method and
-- data of EcoLogits). An estimate, not a measurement: closed models do not
-- publish their size, so each figure is a range, min and max (equal when
-- the model is known exactly). NULL when there is no estimate: a model
-- EcoLogits does not know, or a request without output. Never zero for
-- "unknown".
--
--   impact_energy_wh   energy, datacenter overhead (PUE) included, Wh
--   impact_gwp_g       emissions, electricity plus the request's share of
--                      making the hardware, g CO2eq
--   impact_water_ml    water, cooling and electricity generation, mL
--   impact_pe_kj       primary energy, kJ
--   impact_adpe_mg     abiotic resource depletion, mg Sb eq
--   impact_zone        electricity mix used (ISO 3166-1 alpha-3, or WOR)
--   impact_method      e.g. ecologits-0.11.3: a later change of method or
--                      data applies from its date; stored rows are not
--                      recomputed
--
-- Columns on the partitioned table reach every partition. Idempotent.

BEGIN;

ALTER TABLE request_logs
  ADD COLUMN IF NOT EXISTS impact_energy_wh_min DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS impact_energy_wh_max DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS impact_gwp_g_min     DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS impact_gwp_g_max     DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS impact_water_ml_min  DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS impact_water_ml_max  DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS impact_pe_kj_min     DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS impact_pe_kj_max     DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS impact_adpe_mg_min   DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS impact_adpe_mg_max   DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS impact_zone          TEXT,
  ADD COLUMN IF NOT EXISTS impact_method        TEXT;

COMMIT;
