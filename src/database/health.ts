import type { Pool } from "pg";

/**
 * Return a lightweight database health-check function.
 *
 * The returned function issues a single "SELECT 1" query. It returns true
 * when the pool can reach the database and false on any error, without
 * leaking internal details to the caller.
 */
export function createDbHealthChecker(pool: Pool): () => Promise<boolean> {
  return async (): Promise<boolean> => {
    try {
      await pool.query("SELECT 1");
      return true;
    } catch {
      return false;
    }
  };
}
