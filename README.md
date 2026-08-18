# LogPulse

A high-performance structured log ingestion, querying, aggregation, and retention service built as an internship final project.

## Purpose

LogPulse accepts structured application logs, stores them durably in PostgreSQL, and exposes a query API with filtering, cursor-based pagination, and time-range aggregation. This README documents only what is currently implemented.

## Current architecture

```text
src/
  config.ts              <- typed environment validation (fail-fast)
  app.ts                 <- buildApp() factory (testable without a real port)
  server.ts              <- startup sequence + graceful shutdown
  database/
    pool.ts              <- pg connection pool
    migrate.ts           <- SQL migration runner
    health.ts            <- lightweight DB health check
  logs/
    log.types.ts            ingestion request/result types
    log.validation.ts       pure per-entry validation + normalization
    log.cursor.ts           signed opaque cursor helpers
    log.query-validation.ts typed query parsing and validation
    log.query-builder.ts    parameterized SQL query builders
    log.ingestion-batcher.ts concurrent insert coalescer + adaptive flushing
    log.service.ts          batch validation + persistence coordination
    log.repository.ts       bulk insert (unnest/multirow) + query execution
  retention/
    retention.types.ts      retention configuration and result types
    retention.repository.ts bounded CTE batch deletion
    retention.service.ts    retention execution coordination
    retention.worker.ts     periodic background cleanup loop
  routes/
    health.route.ts      <- GET /health
    logs.route.ts        <- GET /logs, POST /logs, GET /logs/aggregate
migrations/
  001_initial_logs.sql         <- logs table + initial ordering indexes
  002_minute_aggregates.sql    <- log_minute_aggregates table for fast rollups
  003_performance_indexes.sql  <- GIN jsonb_path_ops and composite indexes
tests/
  app.test.ts
  config.test.ts
  health.test.ts
  log.ingestion-batcher.test.ts
  log.query-builder.test.ts
  log.query-validation.test.ts
  log.repository.test.ts
  log.validation.test.ts
  logs.ingestion.test.ts
  logs.query.route.test.ts
  logs.query.service.test.ts
  logs.route.test.ts
  retention.service.test.ts
  retention.worker.test.ts
  integration/
    logs.integration.ts
```

Additional hardening and benchmark assets:

```text
scripts/                   smoke, demo, HTTP seed, and local benchmark helpers
load-tests/                k6 ingestion/query/mixed workload scripts
docs/PERFORMANCE.md        measured performance report
.github/workflows/ci.yml   CI with PostgreSQL integration and smoke test
```

## Requirements

- Node.js 24 LTS
- npm 10+
- PostgreSQL 18 (for local development without Docker)
- Docker + Docker Compose (for the containerised stack)

## Local installation

```bash
git clone <repo>
cd logIJA
npm install
cp .env.example .env   # optional — defaults work out of the box
```

## Environment configuration

| Variable                          | Default                                            | Allowed values                                               |
| --------------------------------- | -------------------------------------------------- | ------------------------------------------------------------ |
| `NODE_ENV`                        | `development`                                      | `development`, `test`, `production`                          |
| `HOST`                            | `0.0.0.0`                                          | any non-empty string                                         |
| `PORT`                            | `8080`                                             | integer 1–65535                                              |
| `LOG_LEVEL`                       | `info`                                             | `trace`, `debug`, `info`, `warn`, `error`, `fatal`, `silent` |
| `DATABASE_URL`                    | `postgresql://logija:logija@localhost:5432/logija` | any `postgresql://` or `postgres://` URL                     |
| `CURSOR_SECRET`                   | `logija-local-cursor-secret`                       | any non-empty string                                         |
| `DB_POOL_MAX`                     | `10`                                               | integer 1–100                                                |
| `INGEST_STRATEGY`                 | `unnest`                                           | `unnest`, `multirow`                                         |
| `INGEST_BATCH_MAX_LOGS`           | `2500`                                             | integer 1–5000                                               |
| `INGEST_BATCH_WAIT_MS`            | `5`                                                | integer 1–1000                                               |
| `INGEST_BATCH_CONCURRENCY`        | `3`                                                | integer 1–10                                                 |
| `RETENTION_DAYS`                  | `30`                                               | integer 1–3650                                               |
| `RETENTION_INTERVAL_SECONDS`      | `60`                                               | integer 1–86400                                              |
| `RETENTION_BATCH_SIZE`            | `10000`                                            | integer 1–100000                                             |
| `RETENTION_MAX_BATCHES_PER_CYCLE` | `10`                                               | integer 1–1000                                               |

An explicit invalid value causes an immediate startup failure with a descriptive error message. A missing variable silently uses the default.

## Development usage

```bash
# Type-check all sources (src + tests)
npm run typecheck

# Lint
npm run lint

# Format sources
npm run format

# Check formatting without writing
npm run format:check

# Run unit tests (no database required)
npm test

# Run PostgreSQL integration tests (requires PostgreSQL)
npm run test:integration

# Run required API contract smoke test against a running server
npm run smoke

# Run demo sequence against a running server
npm run demo

# Local HTTP benchmarks
npm run benchmark:ingest
npm run benchmark:query
npm run benchmark:filtered-query
npm run benchmark:mixed
npm run benchmark:rate
npm run seed:http

# Node read throughput benchmark
node scripts/benchmark-read.mjs

# k6 benchmarks, requires k6 installed separately
npm run load:ingest
npm run load:query
npm run load:mixed

# Watch mode
npm run test:watch

# Compile TypeScript -> dist/
npm run build

# Run all gates sequentially
npm run check

# Start development server with hot-reload (requires PostgreSQL)
npm run dev

# Run compiled production server (requires PostgreSQL)
npm start
```

## Docker usage

Start the complete stack (PostgreSQL + application) with no manual setup:

```bash
docker compose up --build
```

The application waits for PostgreSQL to pass its health check before starting, so there is no race condition on first boot. Persistent data is stored in a named Docker volume (`postgres_data`).

Stop cleanly:

```bash
docker compose down
```

Destroy data volumes too:

```bash
docker compose down -v
```

## API

### `GET /health`

Returns `200 OK` when the service is running and the database is reachable.

```json
{ "status": "ok" }
```

Returns `503 Service Unavailable` if the database cannot be reached:

```json
{ "status": "unavailable" }
```

The service only becomes available after:

1. Environment config validates successfully.
2. The connection pool is created.
3. All pending SQL migrations complete.
4. Fastify starts listening.

### `POST /logs`

Accepts a batch of structured log entries. A batch containing one entry is valid. A single raw log object outside the `logs` array is not supported.

```json
{
  "logs": [
    {
      "timestamp": "2026-07-20T14:32:01.123Z",
      "level": "error",
      "service": "checkout",
      "message": "payment declined",
      "attributes": {
        "user_id": "42",
        "region": "eu-west",
        "retries": 3
      }
    }
  ]
}
```

Successful response:

```json
{
  "accepted": 1,
  "rejected": []
}
```

Mixed-validity batches are partially accepted. Invalid entries do not prevent valid entries from being stored, and rejected entries report their original array index:

```json
{
  "accepted": 2,
  "rejected": [
    {
      "index": 1,
      "reason": "invalid level: 'critical'"
    }
  ]
}
```

#### Validation rules

- `timestamp` is required, must be a strict RFC3339-style instant with `Z` or an explicit numeric offset, and must not be more than 5 minutes in the future. Accepted timestamps are normalized to UTC before storage.
- `level` is required and must be exactly one of `debug`, `info`, `warn`, or `error`.
- `service` is required, must be a string, and must not be empty or whitespace-only.
- `message` is required, must be a string, and must not be empty or whitespace-only. The original valid message is preserved.
- `attributes` is optional and defaults to `{}`. When provided, it must be a flat object whose values are only strings, finite numbers, or booleans. `null`, arrays, nested objects, and non-JSON values are rejected.
- Unknown extra fields on a log entry are tolerated and ignored. This is intentional because the required contract does not prohibit producer-specific fields, and ignoring them avoids storing undeclared data.

#### Status codes

- `200 OK` when at least one valid log entry is durably stored, even if other entries in the batch are rejected.
- `400 Bad Request` when every submitted log entry is rejected, the top-level body is malformed, JSON is malformed, or the batch is empty.
- `413 Payload Too Large` when the batch exceeds the implementation limit.
- `500 Internal Server Error` when persistence fails. Database details are logged internally and not exposed to the client.

An empty batch is treated as invalid because no entry can be accepted:

```json
{
  "accepted": 0,
  "rejected": [
    {
      "index": -1,
      "reason": "logs must contain at least one entry"
    }
  ]
}
```

#### Batch size limit

The maximum accepted batch size is `5000` log entries. This keeps memory use bounded for the 256 MB application container while still allowing high-throughput load generators to send practical batches.

The Fastify JSON body limit is `10 MiB`, so oversized request bodies are rejected before ingestion work begins.

#### Attribute normalization

Accepted entries store both:

- `attributes`: the original flat JSON object with value types preserved.
- `attributes_search`: a flat JSON object with every value converted to a string.

Example:

```json
{
  "attributes": {
    "user_id": "42",
    "attempts": 3,
    "success": false
  },
  "attributes_search": {
    "user_id": "42",
    "attempts": "3",
    "success": "false"
  }
}
```

#### Ingestion pipeline & batching strategy

1. **Ingestion Batcher (`log.ingestion-batcher.ts`)**: Coalesces concurrent incoming HTTP ingestion requests into bounded, adaptive database writes with configurable concurrency (`INGEST_BATCH_CONCURRENCY`) and wait window (`INGEST_BATCH_WAIT_MS`). Callers settle only after the shared database `INSERT` transaction has committed.
2. **Bulk Ingestion Strategies**:
   - **`unnest` (Default)**: Passes typed arrays to PostgreSQL using `unnest()`, minimizing query parsing overhead. Uses an atomic CTE that inserts logs and updates `log_minute_aggregates` in a single round-trip.
   - **`multirow`**: Generates a parameterized multi-row `INSERT INTO logs VALUES (...)` query.

### `GET /logs`

Returns stored logs sorted by `timestamp DESC, id DESC`. The `id` tie-breaker keeps ordering deterministic when multiple logs share the same timestamp.

Supported query parameters are optional and may be combined:

- `service`: exact service-name equality.
- `level`: exact level match; allowed values are `debug`, `info`, `warn`, and `error`.
- `since`: inclusive strict timestamp filter, `timestamp >= since`.
- `until`: exclusive strict timestamp filter, `timestamp < until`. When both `since` and `until` are provided, `until` must be later.
- `attr.<key>`: flat attribute equality using `attributes_search`, so numbers and booleans are compared by their string-normalized values.
- `q`: case-insensitive literal substring search against `message`.
- `limit`: defaults to `100`, minimum `1`, maximum `1000`.
- `cursor`: opaque cursor returned from a previous page.

Example:

```http
GET /logs?service=checkout&level=error&attr.user_id=42&q=declined&limit=50
```

Response:

```json
{
  "logs": [
    {
      "id": "123",
      "timestamp": "2026-07-20T14:32:01.123Z",
      "level": "error",
      "service": "checkout",
      "message": "payment declined",
      "attributes": {
        "user_id": "42",
        "retries": 3
      }
    }
  ],
  "next_cursor": null
}
```

Pagination uses keyset pagination rather than `OFFSET`. Each query fetches `limit + 1` rows to determine whether another page exists. If another page exists, `next_cursor` is a signed, URL-safe, opaque cursor containing the last returned row's timestamp and string ID. Invalid or tampered cursors return `400 Bad Request`.

`q` uses escaped `ILIKE`, so `%` and `_` in the user input are treated as literal characters, not SQL wildcards. Searching for `100%` means the substring `100%`.

### `GET /logs/aggregate`

Returns non-empty time buckets for matching logs.

Required parameters:

- `since`: inclusive strict timestamp.
- `until`: exclusive strict timestamp; must be later than `since`.
- `bucket`: one of `1m`, `5m`, `1h`, or `1d`.

Optional filters:

- `service`
- `level`
- `attr.<key>`
- `q`
- `group_by`: either `service` or `level`.

Examples:

```http
GET /logs/aggregate?since=2026-07-20T14:00:00Z&until=2026-07-20T15:00:00Z&bucket=1m
```

```http
GET /logs/aggregate?since=2026-07-20T14:00:00Z&until=2026-07-20T15:00:00Z&bucket=1m&group_by=service
```

Response:

```json
{
  "buckets": [
    {
      "start": "2026-07-20T14:00:00.000Z",
      "group": "checkout",
      "count": 118
    }
  ]
}
```

Without `group_by`, `group` is `null`. Empty bucket/group combinations are not generated.

**Performance Optimization**: Simple aggregations (without `attr.*` or `q` filters) are served directly from the `log_minute_aggregates` pre-aggregated roll-up table, eliminating full table scans on the primary `logs` table.

## Database startup and migration behaviour

At startup, `runMigrations()` in `src/database/migrate.ts`:

1. Creates the `schema_migrations` table if it does not exist.
2. Reads all `*.sql` files from `migrations/` in filename order.
3. Skips any file whose name already appears in `schema_migrations`.
4. Runs each new migration inside an explicit `BEGIN` / `COMMIT` transaction.
5. Records the filename on success; rolls back and throws on failure.

Startup is aborted if any migration fails, ensuring the application never runs against an unexpected schema state.

## Current schema

### 1. `logs` Table (`001_initial_logs.sql`)

```sql
CREATE TABLE logs (
  id                BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  timestamp         TIMESTAMPTZ NOT NULL,
  level             TEXT        NOT NULL CHECK (level IN ('debug', 'info', 'warn', 'error')),
  service           TEXT        NOT NULL,
  message           TEXT        NOT NULL,
  attributes        JSONB,
  attributes_search JSONB
);
```

### 2. `log_minute_aggregates` Table (`002_minute_aggregates.sql`)

```sql
CREATE TABLE log_minute_aggregates (
  minute    TIMESTAMPTZ NOT NULL,
  service   TEXT        NOT NULL,
  level     TEXT        NOT NULL CHECK (level IN ('debug', 'info', 'warn', 'error')),
  count     BIGINT      NOT NULL CHECK (count >= 0),
  PRIMARY KEY (minute, service, level)
);
```

### `attributes` vs `attributes_search`

Two JSONB columns are used intentionally:

- **`attributes`** — stores the log's original attribute values with their native JSON types. A numeric `retries: 3` stays a number; a boolean `success: false` stays a boolean. This column is returned in API responses so callers receive the original types.
- **`attributes_search`** — stores the same flat key-value map with every value coerced to a string (`"3"`, `"false"`). This column enables consistent equality matching for `attr.<key>=<value>` query parameters with the GIN index.

## Current indexes

| Index name                         | Table                   | Columns                                        | Justification                                                                    |
| ---------------------------------- | ----------------------- | ---------------------------------------------- | -------------------------------------------------------------------------------- |
| `idx_logs_ts_id`                   | `logs`                  | `(timestamp DESC, id DESC)`                    | Every list query orders by timestamp then ID. Primary ordering index.            |
| `idx_logs_service_ts_id`           | `logs`                  | `(service, timestamp DESC, id DESC)`           | `GET /logs?service=X` filters on service then applies timestamp ordering.        |
| `idx_logs_level_ts_id`             | `logs`                  | `(level, timestamp DESC, id DESC)`             | `GET /logs?level=X` filters on level then applies timestamp ordering.            |
| `idx_logs_service_level_ts_id`     | `logs`                  | `(service, level, timestamp DESC, id DESC)`    | Fast multi-column filtering when both `service` and `level` are specified.       |
| `idx_logs_attributes_search_gin`   | `logs`                  | `USING gin (attributes_search jsonb_path_ops)` | Enables sub-millisecond `@>` containment queries on normalized JSONB attributes. |
| `idx_log_minute_aggregates_minute` | `log_minute_aggregates` | `(minute ASC)`                                 | Fast index range scans for pre-aggregated time-bucket aggregations.              |

## Final Architecture

```text
Clients
  |
  v
Fastify API
  |
  +-- Health readiness
  +-- Ingestion validation & batching (coalescer)
  +-- Query parsing & signed cursor handling
  +-- Retention worker (bounded CTE cleanup)
  |
  v
node-postgres pool (tuned sizing)
  |
  v
PostgreSQL (logs + log_minute_aggregates tables)
```

## Retention Strategy

Retention starts after migrations and runs periodically. Defaults keep logs for `30` days, run every `60` seconds, delete up to `10000` rows per batch, and run up to `10` batches per cycle.

Deletion is bounded with a CTE that selects expired IDs by `timestamp ASC, id ASC` and deletes only that batch. This keeps transactions short, avoids one large unbounded delete, and reduces disruption to ingestion. The worker prevents overlapping cycles and logs cycle-level results only.

## CI

GitHub Actions runs `npm ci`, typecheck, lint, format check, unit tests, build, PostgreSQL integration tests, and a required API smoke test covering:

- `GET /health`
- `POST /logs`
- `GET /logs`
- `GET /logs/aggregate`

Heavy million-row load tests are intentionally not run on every CI execution.

## Performance Methodology

Benchmarks target the HTTP API. Local Docker limits are:

- app: `0.5 CPU`, `256 MiB`
- PostgreSQL: `1 CPU`, `1 GiB`

The local environment was Windows Docker Desktop. Detailed results are in [docs/PERFORMANCE.md](docs/PERFORMANCE.md).

Summary:

- Ingestion throughput achieves high concurrent batching via `unnest` CTEs and in-memory request coalescing.
- Read throughput reaches `>25,000 logs/sec` on `GET /logs`.
- Pre-aggregated rollups reduce aggregation latency on large datasets.

## Known Limitations

- No authentication, rate limiting, multi-tenancy, dashboard, alerts, or live-tail.
- k6 must be installed separately to run `npm run load:*`.
- Windows Docker Desktop resource readings are approximate.
