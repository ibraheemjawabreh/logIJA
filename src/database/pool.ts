import { Pool } from "pg";

/**
 * Create a PostgreSQL connection pool.
 *
 * Pool size is intentionally conservative: the target PostgreSQL container
 * has 1 CPU and 1 GB RAM. Keeping max connections low reduces context-switch
 * overhead and memory pressure. This can be tuned once benchmarked.
 */
export function createPool(connectionString: string, max = 10): Pool {
  return new Pool({
    connectionString,
    max,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });
}
