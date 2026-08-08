import type { Pool } from "pg";
import type { RetentionRepository } from "./retention.types.js";

export function createRetentionRepository(pool: Pool): RetentionRepository {
  return {
    async deleteExpiredBatch(cutoff: string, batchSize: number): Promise<number> {
      const result = await pool.query(
        `
          WITH expired AS (
            SELECT id
            FROM logs
            WHERE timestamp < $1::timestamptz
            ORDER BY timestamp ASC, id ASC
            LIMIT $2
          )
          DELETE FROM logs
          USING expired
          WHERE logs.id = expired.id
        `,
        [cutoff, batchSize],
      );

      return result.rowCount ?? 0;
    },
  };
}
