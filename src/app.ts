import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
import { healthRoute, type HealthDeps } from "./routes/health.route.js";
import { logsRoute, type LogsRouteDeps } from "./routes/logs.route.js";
import type { Config } from "./config.js";

export type AppDeps = HealthDeps & Omit<LogsRouteDeps, "cursorSecret">;

const BODY_LIMIT_BYTES = 10 * 1024 * 1024;

export async function buildApp(config: Config, deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({ bodyLimit: BODY_LIMIT_BYTES, logger: { level: config.LOG_LEVEL } });

  // Centralised error handler.
  // 4xx errors (e.g. validation failures) pass through with their own message.
  // 5xx errors are logged in full but returned as a generic message so that
  // stack traces, SQL, and filesystem paths never reach the client.
  app.setErrorHandler((error: FastifyError, _request, reply) => {
    app.log.error(error);
    const statusCode = error.statusCode ?? 500;
    if (statusCode >= 500) {
      void reply.status(statusCode).send({ error: "internal server error" });
      return;
    }
    void reply.status(statusCode).send({ error: error.message });
  });

  // Return a clean 404 for any route that is not registered.
  app.setNotFoundHandler((_request, reply) => {
    void reply.status(404).send({ error: "not found" });
  });

  await app.register(healthRoute, { checkDb: deps.checkDb });
  await app.register(logsRoute, {
    ingestLogs: deps.ingestLogs,
    queryLogs: deps.queryLogs,
    aggregateLogs: deps.aggregateLogs,
    cursorSecret: config.CURSOR_SECRET,
  });

  return app;
}
