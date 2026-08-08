# LogPulse

A high-performance structured log ingestion, querying, aggregation, and retention service built as an internship final project.

## Purpose

LogPulse accepts structured application logs, stores them durably in PostgreSQL, and exposes a query API with filtering, cursor-based pagination, and time-range aggregation. This README documents only what is currently implemented.

## Current architecture

```
src/
  config.ts              ← typed environment validation (fail-fast)
  app.ts                 ← buildApp() factory (testable without a real port)
  server.ts              ← startup sequence + graceful shutdown
  database/
    pool.ts              ← pg connection pool
    migrate.ts           ← SQL migration runner
    health.ts            ← lightweight DB health check
  logs/
    log.types.ts         ingestion request/result types
    log.validation.ts    pure per-entry validation + normalization
    log.cursor.ts        signed opaque cursor helpers
    log.query-validation.ts typed query parsing and validation
    log.query-builder.ts parameterized SQL query builders
    log.service.ts       batch validation + persistence coordination
    log.repository.ts    bulk insert + query execution
  routes/
    health.route.ts      ← GET /health
    logs.route.ts        POST /logs
migrations/
  001_initial_logs.sql   ← logs table + initial indexes
tests/
  config.test.ts
  health.test.ts
  app.test.ts
  log.query-builder.test.ts
  log.query-validation.test.ts
  log.validation.test.ts
  logs.ingestion.test.ts
  logs.query.route.test.ts
  logs.query.service.test.ts
  logs.route.test.ts
  integration/
    logs.integration.ts
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

| Variable        | Default                                            | Allowed values                                               |
| --------------- | -------------------------------------------------- | ------------------------------------------------------------ |
| `NODE_ENV`      | `development`                                      | `development`, `test`, `production`                          |
| `HOST`          | `0.0.0.0`                                          | any non-empty string                                         |
| `PORT`          | `8080`                                             | integer 1–65535                                              |
| `LOG_LEVEL`     | `info`                                             | `trace`, `debug`, `info`, `warn`, `error`, `fatal`, `silent` |
| `DATABASE_URL`  | `postgresql://logija:logija@localhost:5432/logija` | any `postgresql://` or `postgres://` URL                     |
| `CURSOR_SECRET` | `logija-local-cursor-secret`                       | any non-empty string                                         |

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

# Run tests (no database required)
npm test

# Run PostgreSQL integration tests (requires PostgreSQL)
npm run test:integration

# Watch mode
npm run test:watch

# Compile TypeScript → dist/
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

#### Bulk insert strategy

Accepted entries from a request are persisted with one parameterized multi-row PostgreSQL `INSERT`. User-controlled values are always passed as SQL parameters. Invalid entries are filtered before persistence, and the valid entries for one request either persist together or fail together at the insert operation level.

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

## Database startup and migration behaviour

At startup, `runMigrations()` in `src/database/migrate.ts`:

1. Creates the `schema_migrations` table if it does not exist.
2. Reads all `*.sql` files from `migrations/` in filename order.
3. Skips any file whose name already appears in `schema_migrations`.
4. Runs each new migration inside an explicit `BEGIN` / `COMMIT` transaction.
5. Records the filename on success; rolls back and throws on failure.

Startup is aborted if any migration fails, ensuring the application never runs against an unexpected schema state.

## Current schema

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

### `attributes` vs `attributes_search`

Two JSONB columns are used intentionally:

- **`attributes`** — stores the log's original attribute values with their native JSON types. A numeric `retries: 3` stays a number; a boolean `success: false` stays a boolean. This column is returned in API responses so callers receive the original types.

- **`attributes_search`** — stores the same flat key-value map with every value coerced to a string (`"3"`, `"false"`). This column enables consistent equality matching for `attr.<key>=<value>` query parameters, where the search value is always a string regardless of the stored type.

`attributes_search` is populated during ingestion.

## Current indexes

| Index name               | Columns                              | Justification                                                                     |
| ------------------------ | ------------------------------------ | --------------------------------------------------------------------------------- |
| `idx_logs_ts_id`         | `(timestamp DESC, id DESC)`          | Every list query orders by timestamp then ID. This is the primary ordering index. |
| `idx_logs_service_ts_id` | `(service, timestamp DESC, id DESC)` | `GET /logs?service=X` filters on service then applies timestamp ordering.         |
| `idx_logs_level_ts_id`   | `(level, timestamp DESC, id DESC)`   | `GET /logs?level=X` filters on level then applies timestamp ordering.             |

### Why these and not others

- **No GIN index on `attributes` or `attributes_search`** — GIN indexes increase write amplification significantly. They will be benchmarked against ingestion throughput before being added.
- **No `pg_trgm` index on `message`** — `q` substring search is implemented for correctness first; trigram indexing will be benchmarked before adding write amplification.
- Every index increases ingestion cost. The index set will be re-evaluated after measuring real insert throughput.

## Intentional omissions

- **No table partitioning** — the dataset target (~1 M rows) is small enough that a plain table is correct and easy to manage. Time-based partitioning will be considered only after retention benchmarks show it is justified.
- **No authentication or rate limiting** — out of scope for this phase.
- **No performance claims yet** — ingestion is structured for later benchmarking, but no throughput target is claimed until load testing is performed.
