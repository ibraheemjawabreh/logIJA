import { Pool, types } from "pg";

// Parse INT8 (BIGINT) as string to prevent JS precision loss
types.setTypeParser(20, (val) => val);

/**
 * Create a PostgreSQL connection pool.
 *
 * Configured for high-throughput batch ingestion and fast concurrent reads.
 * We embed -c synchronous_commit=off as a startup option so every connection
 * inherits it without a post-connect SET query (which would trigger a pg
 * deprecation warning if called during an in-flight connection establishment).
 */
export function createPool(connectionString: string, max = 25): Pool {
  // Append options=-c%20synchronous_commit%3Doff as a PostgreSQL startup parameter
  // so every new connection uses asynchronous commits without an extra round-trip.
  const url = new URL(connectionString);
  const existingOptions = url.searchParams.get("options") ?? "";
  const syncCommitOption = "-c synchronous_commit=off";
  if (!existingOptions.includes("synchronous_commit")) {
    url.searchParams.set(
      "options",
      existingOptions ? `${existingOptions} ${syncCommitOption}` : syncCommitOption,
    );
  }

  const pool = new Pool({
    connectionString: url.toString(),
    max,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 15_000,
  });

  pool.on("error", () => {
    // Suppress unhandled error events on idle clients to prevent process crash
  });

  return pool;
}
