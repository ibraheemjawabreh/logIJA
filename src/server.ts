import { loadConfig } from "./config.js";
import { createPool } from "./database/pool.js";
import { runMigrations } from "./database/migrate.js";
import { createDbHealthChecker } from "./database/health.js";
import { buildApp } from "./app.js";
import { createLogRepository } from "./logs/log.repository.js";
import { createLogIngestionService } from "./logs/log.service.js";
import { createRetentionRepository } from "./retention/retention.repository.js";
import { createRetentionService } from "./retention/retention.service.js";
import { createRetentionWorker } from "./retention/retention.worker.js";

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

  const pool = createPool(config.DATABASE_URL, config.DB_POOL_MAX);

  // Migrations also act as the DB connectivity check at startup.
  // If the DB is unreachable, runMigrations throws and main() rejects.
  await runMigrations(pool);

  const checkDb = createDbHealthChecker(pool);
  const logsRepository = createLogRepository(pool, config.INGEST_STRATEGY);
  const logsService = createLogIngestionService(logsRepository, {
    cursorSecret: config.CURSOR_SECRET,
  });
  const retentionRepository = createRetentionRepository(pool);
  const retentionService = createRetentionService(retentionRepository, {
    retentionDays: config.RETENTION_DAYS,
    intervalSeconds: config.RETENTION_INTERVAL_SECONDS,
    batchSize: config.RETENTION_BATCH_SIZE,
    maxBatchesPerCycle: config.RETENTION_MAX_BATCHES_PER_CYCLE,
  });
  const app = await buildApp(config, {
    checkDb,
    ingestLogs: logsService.ingestLogs,
    queryLogs: logsService.queryLogs,
    aggregateLogs: logsService.aggregateLogs,
  });
  const retentionWorker = createRetentionWorker(retentionService, {
    intervalSeconds: config.RETENTION_INTERVAL_SECONDS,
    logger: {
      info: (message, data) => app.log.info(data ?? {}, message),
      error: (message, data) => app.log.error(data ?? {}, message),
    },
  });
  retentionWorker.start();

  let isShuttingDown = false;

  async function shutdown(signal: string): Promise<void> {
    if (isShuttingDown) return;
    isShuttingDown = true;

    app.log.info(`Received ${signal}. Shutting down gracefully...`);
    try {
      retentionWorker.stop();
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
