-- 002_minute_aggregates.sql
--
-- Stores exact minute/service/level counters for the common aggregate paths.
-- The base logs table remains the source of truth for attribute and text
-- filtered aggregation, which cannot be represented by these counters.

CREATE TABLE IF NOT EXISTS log_minute_aggregates (
  minute    TIMESTAMPTZ NOT NULL,
  service   TEXT        NOT NULL,
  level     TEXT        NOT NULL
                        CHECK (level IN ('debug', 'info', 'warn', 'error')),
  count     BIGINT      NOT NULL
                        CHECK (count >= 0),
  PRIMARY KEY (minute, service, level)
);

INSERT INTO log_minute_aggregates (minute, service, level, count)
SELECT
  date_bin('1 minute'::interval, timestamp, '1970-01-01 00:00:00+00'::timestamptz),
  service,
  level,
  COUNT(*)
FROM logs
GROUP BY 1, 2, 3
ON CONFLICT (minute, service, level) DO UPDATE
SET count = EXCLUDED.count;
