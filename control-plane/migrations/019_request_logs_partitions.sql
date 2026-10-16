-- 019_request_logs_partitions.sql
--
-- request_logs is partitioned by month and 001 created partitions only up to
-- January 2027: from February 2027 every insert would fail.
--
-- - stratum_ensure_request_log_partitions(months_ahead) creates the monthly
--   partitions from the current month to months_ahead months later. The
--   control plane calls it when it starts and once a day (instrumentation.js);
--   this migration calls it for 24 months.
-- - A DEFAULT partition takes any row no monthly partition covers, so an
--   insert never fails because a partition is missing. A month whose rows
--   already landed there is skipped (Postgres refuses to create a partition
--   for rows the default holds) and reported with a warning.
--
-- Idempotent: safe to run more than once.

BEGIN;

CREATE OR REPLACE FUNCTION stratum_ensure_request_log_partitions(months_ahead INT DEFAULT 24)
RETURNS INT LANGUAGE plpgsql AS $$
DECLARE
  first_month DATE := date_trunc('month', now())::date;
  m           DATE;
  name        TEXT;
  created     INT  := 0;
  busy        BOOLEAN;
BEGIN
  FOR i IN 0..months_ahead LOOP
    m := (first_month + make_interval(months => i))::date;
    name := format('request_logs_%s', to_char(m, 'YYYY_MM'));
    CONTINUE WHEN to_regclass(name) IS NOT NULL;
    IF to_regclass('request_logs_default') IS NOT NULL THEN
      EXECUTE 'SELECT EXISTS (SELECT 1 FROM request_logs_default WHERE created_at >= $1 AND created_at < $2)'
        INTO busy USING m, (m + interval '1 month');
      IF busy THEN
        RAISE WARNING 'request_logs_default holds rows for %; partition % not created', to_char(m, 'YYYY-MM'), name;
        CONTINUE;
      END IF;
    END IF;
    EXECUTE format('CREATE TABLE %I PARTITION OF request_logs FOR VALUES FROM (%L) TO (%L)',
                   name, m, (m + interval '1 month')::date);
    created := created + 1;
  END LOOP;
  RETURN created;
END;
$$;

DO $$ BEGIN PERFORM stratum_ensure_request_log_partitions(24); END $$;

-- After the monthly ones, so they are not blocked by rows it might hold.
CREATE TABLE IF NOT EXISTS request_logs_default PARTITION OF request_logs DEFAULT;

COMMIT;
