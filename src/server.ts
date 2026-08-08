import { loadConfig } from "./config.js";
import { createPool } from "./database/pool.js";
import { runMigrations } from "./database/migrate.js";
import { createDbHealthChecker } from "./database/health.js";
import { buildApp } from "./app.js";

/**
 * Startup sequence:
 *   1. Parse and validate environment config — fail fast on bad values.
 *   2. Create the connection pool — no connections opened yet.
 *   3. Run pending SQL migrations — verifies DB connectivity as a side effect.
 *   4. Build the Fastify application.
 *   5. Start listening.
 *
 * The service is not available to clients until steps 1-4 all succeed.
 */
async function main(): Promise<void> {
  const config = loadConfig();

  const pool = createPool(config.DATABASE_URL);

  // Migrations also act as the DB connectivity check at startup.
  // If the DB is unreachable, runMigrations throws and main() rejects.
  await runMigrations(pool);

  const checkDb = createDbHealthChecker(pool);
  const app = await buildApp(config, { checkDb });

  let isShuttingDown = false;

  async function shutdown(signal: string): Promise<void> {
    if (isShuttingDown) return;
    isShuttingDown = true;

    app.log.info(`Received ${signal}. Shutting down gracefully...`);
    try {
      await app.close();
      await pool.end();
      app.log.info("Server closed successfully.");
      process.exit(0);
    } catch (err) {
      app.log.error(err, "Error during shutdown.");
      process.exit(1);
    }
  }

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  await app.listen({ port: config.PORT, host: config.HOST });
}

main().catch((err: unknown) => {
  // At this point the Fastify logger may not be initialised yet, so we use
  // console.error to ensure the fatal message always reaches stdout.
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[fatal] Startup failed: ${message}`);
  process.exit(1);
});
