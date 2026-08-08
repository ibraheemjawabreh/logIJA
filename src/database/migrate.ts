import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { Pool, PoolClient } from "pg";

/**
 * Resolve the migrations directory relative to this compiled file.
 *
 * At development time (tsx):   src/database/migrate.ts  →  ../../migrations  →  migrations/
 * At production time (node):   dist/database/migrate.js →  ../../migrations  →  migrations/
 *
 * Both resolve correctly to the project-root migrations/ directory, so the
 * same path computation works locally and inside the Docker container.
 */
const MIGRATIONS_DIR = fileURLToPath(new URL("../../migrations", import.meta.url));

interface MigrationRow {
  filename: string;
}

/**
 * Run any pending SQL migrations in filename order.
 *
 * Each migration is wrapped in an explicit transaction: if the SQL fails,
 * the transaction rolls back and startup is aborted. An already-applied
 * migration is skipped based on its filename recorded in schema_migrations.
 */
export async function runMigrations(pool: Pool): Promise<void> {
  // Ensure the migrations tracking table exists
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename   TEXT        PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // Collect already-applied filenames
  const applied = await pool
    .query<MigrationRow>("SELECT filename FROM schema_migrations ORDER BY filename")
    .then((r) => new Set(r.rows.map((row) => row.filename)));

  // Read and sort migration files
  const files = (await fs.readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();

  for (const file of files) {
    if (applied.has(file)) {
      continue;
    }

    const filePath = path.join(MIGRATIONS_DIR, file);
    const sql = await fs.readFile(filePath, "utf-8");

    // Each migration runs inside its own transaction for atomicity
    const client: PoolClient = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (filename) VALUES ($1)", [file]);
      await client.query("COMMIT");
      console.log(`[migrate] Applied: ${file}`);
    } catch (err) {
      await client.query("ROLLBACK");
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`[migrate] Failed to apply "${file}": ${message}`);
    } finally {
      client.release();
    }
  }
}
