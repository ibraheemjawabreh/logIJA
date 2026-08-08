-- 001_initial_logs.sql
--
-- Creates the logs table and its initial indexes.
--
-- No partitioning is applied at this stage. The dataset target (~1 M rows)
-- is small enough that a plain table performs well and remains easy to
-- inspect. Partitioning will be evaluated after real ingestion and query
-- benchmarks are available.

CREATE TABLE IF NOT EXISTS logs (
  -- 64-bit identity: monotonically increasing within a session, used as a
  -- deterministic tie-breaker for cursor-based pagination (timestamp, id).
  id                BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

  -- TIMESTAMPTZ stores the moment a log was produced, with timezone offset.
  -- NOT NULL: a log without a timestamp has no ordering anchor.
  timestamp         TIMESTAMPTZ NOT NULL,

  -- Constrained at database level so the storage layer rejects invalid levels
  -- even if application-layer validation is bypassed.
  level             TEXT        NOT NULL
                    CHECK (level IN ('debug', 'info', 'warn', 'error')),

  service           TEXT        NOT NULL,
  message           TEXT        NOT NULL,

  -- Original attributes with native JSON value types preserved
  -- (e.g., numbers stay numbers, booleans stay booleans).
  -- Used in API responses.
  attributes        JSONB,

  -- Flat copy of attributes with every value coerced to TEXT.
  -- Used for equality attribute searches so that attr.retries="3"
  -- and attr.success="false" match consistently regardless of original type.
  -- Populated during ingestion (future phase).
  attributes_search JSONB
);

-- Primary sort index: supports ORDER BY timestamp DESC, id DESC.
-- Every list query uses this order, so this is the most important index.
CREATE INDEX IF NOT EXISTS idx_logs_ts_id
  ON logs (timestamp DESC, id DESC);

-- Service + time index: supports WHERE service = $1 ORDER BY timestamp DESC, id DESC.
-- Service is the expected primary filter for multi-tenant / multi-service deployments.
CREATE INDEX IF NOT EXISTS idx_logs_service_ts_id
  ON logs (service, timestamp DESC, id DESC);

-- Level + time index: supports WHERE level = $1 ORDER BY timestamp DESC, id DESC.
-- Level filters (e.g., show only errors) are a common log viewer pattern.
CREATE INDEX IF NOT EXISTS idx_logs_level_ts_id
  ON logs (level, timestamp DESC, id DESC);

-- Indexes intentionally omitted at this stage:
--   * GIN on attributes / attributes_search  — benchmarked later; every GIN
--     index increases write amplification and ingestion latency.
--   * pg_trgm on message                     — full-text search is not in the
--     required API contract; added only if a later phase requires it.
