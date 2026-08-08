import type { FastifyInstance } from "fastify";
import type { LogIngestionService } from "../logs/log.service.js";
import { parseAggregateQuery, parseLogQuery } from "../logs/log.query-validation.js";
import { MAX_LOGS_PER_BATCH } from "../logs/log.validation.js";

export interface LogsRouteDeps {
  ingestLogs: LogIngestionService["ingestLogs"];
  queryLogs: LogIngestionService["queryLogs"];
  aggregateLogs: LogIngestionService["aggregateLogs"];
  cursorSecret: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function logsRoute(app: FastifyInstance, opts: LogsRouteDeps): Promise<void> {
  app.get("/logs", async (request, reply) => {
    const query = parseLogQuery(request.query, opts.cursorSecret);
    if (!query.ok) {
      return reply.status(400).send({ error: query.error });
    }

    const result = await opts.queryLogs(query.value);
    return reply.status(200).send(result);
  });

  app.get("/logs/aggregate", async (request, reply) => {
    const query = parseAggregateQuery(request.query);
    if (!query.ok) {
      return reply.status(400).send({ error: query.error });
    }

    const result = await opts.aggregateLogs(query.value);
    return reply.status(200).send(result);
  });

  app.post("/logs", async (request, reply) => {
    const body = request.body;
    if (!isRecord(body) || !Array.isArray(body["logs"])) {
      return reply.status(400).send({ error: "request body must be an object with a logs array" });
    }

    const rawLogs = body["logs"] as unknown[];

    if (rawLogs.length === 0) {
      return reply.status(400).send({
        accepted: 0,
        rejected: [{ index: -1, reason: "logs must contain at least one entry" }],
      });
    }

    if (rawLogs.length > MAX_LOGS_PER_BATCH) {
      return reply
        .status(413)
        .send({ error: `logs batch exceeds maximum of ${MAX_LOGS_PER_BATCH}` });
    }

    const result = await opts.ingestLogs(rawLogs);
    const statusCode = result.accepted > 0 ? 200 : 400;
    return reply.status(statusCode).send(result);
  });
}
