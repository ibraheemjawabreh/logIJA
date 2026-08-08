# EXPLAIN ANALYZE Summary

Dataset: 1,000,010 rows, `logs` table plus indexes: 494 MB.

## Recent Logs

Query: `ORDER BY timestamp DESC, id DESC LIMIT 100`

Finding: uses `idx_logs_ts_id`.

Measured execution time: `0.214 ms` on the 240k-row pre-seed dataset.

## Service + Time

Query: `service = 'checkout'` with broad time range, ordered by `timestamp DESC, id DESC LIMIT 100`.

Finding: planner used `idx_logs_ts_id`, filtered service, and returned quickly because the limit found matching rows early.

Measured execution time: `0.574 ms` on the 240k-row pre-seed dataset.

## Level + Time

Query: `level = 'error'` with broad time range, ordered by `timestamp DESC, id DESC LIMIT 100`.

Finding: planner used `idx_logs_ts_id`, filtered level, and returned quickly.

Measured execution time: `1.720 ms` on the 240k-row pre-seed dataset.

## Attribute Equality

Query: `attributes_search ->> 'region' = 'eu-west'` with broad time range and `LIMIT 100`.

Finding: planner used `idx_logs_ts_id` and filtered attributes. This was fast for recent limited pages because matches were common.

Measured execution time: `0.366 ms` on the 240k-row pre-seed dataset.

## Message Substring

Query: `message ILIKE '%declined%'` with broad time range and `LIMIT 100`.

Finding: planner used `idx_logs_ts_id` and filtered message. This was fast for recent limited pages because matches were common.

Measured execution time: `0.838 ms` on the 240k-row pre-seed dataset.

## Aggregation

Query: `date_bin('1 minute', timestamp, epoch)` grouped by service over all available rows.

Finding: aggregation scans the matching timestamp range using an index-only scan, then aggregates and sorts bucket/group rows. On a 1-hour recent window over the million-row dataset, execution was about `523 ms` in `EXPLAIN`, matching API p95 under 1 second for the primary recent-window workload.

Full-dataset aggregation over 1,000,010 rows exceeded the target with API p95 `1752.25 ms`; this is documented as a known limitation rather than hidden.

## Index Decision

No new indexes were added. The measured `LIMIT 100` attribute and message queries were fast enough under the benchmark data, and adding GIN/trigram indexes would increase ingestion write amplification. Full-dataset aggregation is the main slow case, but neither JSONB nor trigram indexing addresses that.
