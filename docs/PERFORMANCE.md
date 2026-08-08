# Performance Report

## Baseline

The service uses a single `logs` table with three btree indexes:

- `timestamp DESC, id DESC`
- `service, timestamp DESC, id DESC`
- `level, timestamp DESC, id DESC`

Ingestion uses parameterized multi-row `INSERT`. Queries use keyset pagination, never `OFFSET`. Aggregation uses PostgreSQL `date_bin` with validated bucket sizes.

Docker limits during local verification:

- app: `0.5 CPU`, `256 MiB`
- PostgreSQL: `1 CPU`, `1 GiB`

Local environment: Windows Docker Desktop. k6 was not installed locally, so k6 scripts were added but measured results came from the checked-in Node HTTP benchmark scripts.

## Bottlenecks

The measured bottleneck is PostgreSQL write throughput under sustained HTTP ingestion. Increasing client concurrency from 4 to 8 made latency worse and introduced failed requests, so more concurrency was not beneficial on this resource profile.

Full-dataset aggregation over ~1M rows also exceeds the 1-second p95 target. Recent-window aggregation, which is the primary operational workload, meets the target.

## Measurements

Best stable ingestion result:

- method: `POST /logs`
- batch size: `5000`
- concurrency: `4`
- accepted logs/sec during 760k HTTP seed: `8824.08`
- rejected logs: `0`
- final dataset: `1,000,010` rows
- relation size including indexes: `494 MB`

Batch sweep:

| Batch | Concurrency | Accepted logs/sec | Failed requests | p95 request latency |
| ----: | ----------: | ----------------: | --------------: | ------------------: |
|   100 |           4 |              1800 |               0 |           461.22 ms |
|   500 |           4 |              4950 |               0 |          1716.07 ms |
|  1000 |           4 |              3800 |               0 |          2999.17 ms |
|  5000 |           4 |              7000 |               0 |          5111.66 ms |
|  5000 |           8 |              6000 |               1 |         14584.06 ms |

Query benchmark on `1,000,010` rows:

| Workload            | list p50 | list p95 | aggregate p50 | aggregate p95 | aggregate p99 |
| ------------------- | -------: | -------: | ------------: | ------------: | ------------: |
| Full dataset range  | 18.64 ms | 59.28 ms |    1321.09 ms |    1752.25 ms |    4244.34 ms |
| Recent 1-hour range |  5.91 ms | 15.28 ms |     160.58 ms |     410.48 ms |     712.68 ms |

## EXPLAIN ANALYZE Findings

See [EXPLAIN_SUMMARY.md](performance/EXPLAIN_SUMMARY.md).

Important findings:

- Recent list queries use `idx_logs_ts_id` effectively.
- Service and level filters are fast for limited recent pages.
- Attribute and message filters were fast for limited recent pages in measured data; GIN/trigram indexes were not justified by current measurements.
- Full-range aggregation is the known slow path.

## Changes Made

- Added configurable retention with bounded batched deletion.
- Added configurable `DB_POOL_MAX`.
- Added smoke, demo, seed, and benchmark scripts.
- Added k6 load-test scripts for environments with k6 installed.
- Added GitHub Actions CI with PostgreSQL integration and smoke coverage.

## Index Changes

No new indexes were added. Measurements did not justify extra write amplification from JSONB GIN or `pg_trgm` indexes.

## Target Evaluation

- `15,000 accepted logs/sec`: not achieved locally. Best measured result was `8824.08 accepted logs/sec`.
- aggregation `p95 < 1 second`: achieved for the primary recent 1-hour aggregation workload (`410.48 ms`), not achieved for full-dataset aggregation (`1752.25 ms`).

## Known Limitations

- k6 was not installed locally, so k6 scripts were not executed in this environment.
- Windows Docker Desktop resource reporting is approximate.
- Full-dataset aggregation over ~1M rows misses the p95 target.
- No partitioning was added; batched retention keeps the simpler table design appropriate for the project scale.
