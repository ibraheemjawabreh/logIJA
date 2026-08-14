/**
 * Environment configuration module.
 *
 * All values are parsed and validated at call time. An invalid explicit value
 * throws immediately so the process cannot start in a misconfigured state. A
 * missing value falls back to the documented development default — the ?? is
 * intentional; we only apply defaults when the variable is absent (undefined),
 * not when it is an empty string.
 */

const VALID_NODE_ENVS = ["development", "test", "production"] as const;
const VALID_LOG_LEVELS = ["trace", "debug", "info", "warn", "error", "fatal", "silent"] as const;
const VALID_INGEST_STRATEGIES = ["multirow", "unnest"] as const;

type NodeEnv = (typeof VALID_NODE_ENVS)[number];
type LogLevel = (typeof VALID_LOG_LEVELS)[number];
export type IngestStrategy = (typeof VALID_INGEST_STRATEGIES)[number];

export interface Config {
  NODE_ENV: NodeEnv;
  HOST: string;
  PORT: number;
  LOG_LEVEL: LogLevel;
  DATABASE_URL: string;
  CURSOR_SECRET: string;
  DB_POOL_MAX: number;
  INGEST_STRATEGY: IngestStrategy;
  INGEST_BATCH_MAX_LOGS: number;
  INGEST_BATCH_WAIT_MS: number;
  INGEST_BATCH_CONCURRENCY: number;
  RETENTION_DAYS: number;
  RETENTION_INTERVAL_SECONDS: number;
  RETENTION_BATCH_SIZE: number;
  RETENTION_MAX_BATCHES_PER_CYCLE: number;
}

function parseNodeEnv(raw: string): NodeEnv {
  if (!(VALID_NODE_ENVS as readonly string[]).includes(raw)) {
    throw new Error(`Invalid NODE_ENV: "${raw}". Must be one of: ${VALID_NODE_ENVS.join(", ")}`);
  }
  return raw as NodeEnv;
}

function parseHost(raw: string): string {
  if (raw.length === 0) {
    throw new Error("Invalid HOST: must not be empty");
  }
  return raw;
}

function parsePort(raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new Error(`Invalid PORT: "${raw}". Must be an integer between 1 and 65535`);
  }
  return n;
}

function parseLogLevel(raw: string): LogLevel {
  if (!(VALID_LOG_LEVELS as readonly string[]).includes(raw)) {
    throw new Error(`Invalid LOG_LEVEL: "${raw}". Must be one of: ${VALID_LOG_LEVELS.join(", ")}`);
  }
  return raw as LogLevel;
}

function parseIngestStrategy(raw: string): IngestStrategy {
  if (!(VALID_INGEST_STRATEGIES as readonly string[]).includes(raw)) {
    throw new Error(
      `Invalid INGEST_STRATEGY: "${raw}". Must be one of: ${VALID_INGEST_STRATEGIES.join(", ")}`,
    );
  }
  return raw as IngestStrategy;
}

function parseDatabaseUrl(raw: string): string {
  if (raw.length === 0) {
    throw new Error("Invalid DATABASE_URL: must not be empty");
  }
  if (!raw.startsWith("postgresql://") && !raw.startsWith("postgres://")) {
    throw new Error('Invalid DATABASE_URL: must start with "postgresql://" or "postgres://"');
  }
  return raw;
}

function parseCursorSecret(raw: string): string {
  if (raw.length === 0) {
    throw new Error("Invalid CURSOR_SECRET: must not be empty");
  }
  return raw;
}

function parsePositiveInteger(raw: string, name: string, max: number): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > max) {
    throw new Error(`Invalid ${name}: "${raw}". Must be an integer between 1 and ${max}`);
  }
  return value;
}

/**
 * Load and validate configuration.
 *
 * @param env - Defaults to process.env. Pass a plain object in tests to avoid
 *              mutating the real process environment.
 */
export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  return {
    NODE_ENV: parseNodeEnv(env["NODE_ENV"] ?? "development"),
    HOST: parseHost(env["HOST"] ?? "0.0.0.0"),
    PORT: parsePort(env["PORT"] ?? "8080"),
    LOG_LEVEL: parseLogLevel(env["LOG_LEVEL"] ?? "info"),
    DATABASE_URL: parseDatabaseUrl(
      env["DATABASE_URL"] ?? "postgresql://logija:logija@localhost:5432/logija",
    ),
    CURSOR_SECRET: parseCursorSecret(env["CURSOR_SECRET"] ?? "logija-local-cursor-secret"),
    DB_POOL_MAX: parsePositiveInteger(env["DB_POOL_MAX"] ?? "10", "DB_POOL_MAX", 100),
    INGEST_STRATEGY: parseIngestStrategy(env["INGEST_STRATEGY"] ?? "unnest"),
    INGEST_BATCH_MAX_LOGS: parsePositiveInteger(
      env["INGEST_BATCH_MAX_LOGS"] ?? "2500",
      "INGEST_BATCH_MAX_LOGS",
      5_000,
    ),
    INGEST_BATCH_WAIT_MS: parsePositiveInteger(
      env["INGEST_BATCH_WAIT_MS"] ?? "5",
      "INGEST_BATCH_WAIT_MS",
      1_000,
    ),
    INGEST_BATCH_CONCURRENCY: parsePositiveInteger(
      env["INGEST_BATCH_CONCURRENCY"] ?? "3",
      "INGEST_BATCH_CONCURRENCY",
      10,
    ),
    RETENTION_DAYS: parsePositiveInteger(env["RETENTION_DAYS"] ?? "30", "RETENTION_DAYS", 3650),
    RETENTION_INTERVAL_SECONDS: parsePositiveInteger(
      env["RETENTION_INTERVAL_SECONDS"] ?? "60",
      "RETENTION_INTERVAL_SECONDS",
      86_400,
    ),
    RETENTION_BATCH_SIZE: parsePositiveInteger(
      env["RETENTION_BATCH_SIZE"] ?? "10000",
      "RETENTION_BATCH_SIZE",
      100_000,
    ),
    RETENTION_MAX_BATCHES_PER_CYCLE: parsePositiveInteger(
      env["RETENTION_MAX_BATCHES_PER_CYCLE"] ?? "10",
      "RETENTION_MAX_BATCHES_PER_CYCLE",
      1_000,
    ),
  };
}
