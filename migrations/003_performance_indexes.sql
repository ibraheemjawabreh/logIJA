-- 003_performance_indexes.sql
--
-- Adds high-performance indexes:
-- 1. pg_trgm extension and GIN trigram index on message for instant ILIKE text search.
-- 2. GIN index with jsonb_path_ops on attributes_search for instant attribute containment queries.
-- 3. Composite index on (service, level, timestamp DESC, id DESC) for combined filters.
-- 4. Fast index on log_minute_aggregates (minute ASC) for range aggregations.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS idx_logs_attributes_search_gin
  ON logs USING gin (attributes_search jsonb_path_ops);

CREATE INDEX IF NOT EXISTS idx_logs_message_trgm
  ON logs USING gin (message gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_logs_service_level_ts_id
  ON logs (service, level, timestamp DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_log_minute_aggregates_minute
  ON log_minute_aggregates (minute ASC);
