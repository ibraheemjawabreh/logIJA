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

type NodeEnv = (typeof VALID_NODE_ENVS)[number];
type LogLevel = (typeof VALID_LOG_LEVELS)[number];

export interface Config {
  NODE_ENV: NodeEnv;
  HOST: string;
  PORT: number;
  LOG_LEVEL: LogLevel;
  DATABASE_URL: string;
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

function parseDatabaseUrl(raw: string): string {
  if (raw.length === 0) {
    throw new Error("Invalid DATABASE_URL: must not be empty");
  }
  if (!raw.startsWith("postgresql://") && !raw.startsWith("postgres://")) {
    throw new Error('Invalid DATABASE_URL: must start with "postgresql://" or "postgres://"');
  }
  return raw;
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
  };
}
