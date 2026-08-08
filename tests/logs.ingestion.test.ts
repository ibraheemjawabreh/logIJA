import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createLogIngestionService } from "../src/logs/log.service.js";
import type { LogRepository, ValidatedLog } from "../src/logs/log.types.js";

const config = loadConfig({ LOG_LEVEL: "silent" });
const checkDb = async (): Promise<boolean> => true;
const now = new Date("2026-07-20T14:32:00.000Z");

function validLog(message = "payment declined"): Record<string, unknown> {
  return {
    timestamp: "2026-07-20T14:32:01.123Z",
    level: "error",
    service: "checkout",
    message,
    attributes: { user_id: "42", retries: 3 },
  };
}

describe("POST /logs ingestion pipeline", () => {
  let app: FastifyInstance;
  let insertedLogs: ValidatedLog[];

  beforeEach(async () => {
    insertedLogs = [];
    const repository: LogRepository = {
      insertLogs: async (logs) => {
        insertedLogs.push(...logs);
      },
      listLogs: async () => [],
      aggregateLogs: async () => [],
    };
    const service = createLogIngestionService(repository, {
      now: () => now,
      cursorSecret: config.CURSOR_SECRET,
    });
    app = await buildApp(config, {
      checkDb,
      ingestLogs: service.ingestLogs,
      queryLogs: service.queryLogs,
      aggregateLogs: service.aggregateLogs,
    });
  });

  afterEach(async () => {
    await app.close();
  });

  it("validates and persists an all-valid batch", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/logs",
      payload: { logs: [validLog("one"), validLog("two"), validLog("three")] },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ accepted: 3, rejected: [] });
    expect(insertedLogs).toHaveLength(3);
  });

  it("inserts valid entries and reports original indexes for invalid entries", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/logs",
      payload: {
        logs: [validLog("one"), { ...validLog("two"), level: "critical" }, validLog("three")],
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      accepted: 2,
      rejected: [{ index: 1, reason: "invalid level: 'critical'" }],
    });
    expect(insertedLogs.map((log) => log.message)).toEqual(["one", "three"]);
  });

  it("does not call the repository when all entries are invalid", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/logs",
      payload: {
        logs: [
          { ...validLog("one"), level: "critical" },
          { ...validLog("two"), message: "" },
        ],
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({
      accepted: 0,
      rejected: [
        { index: 0, reason: "invalid level: 'critical'" },
        { index: 1, reason: "message must be non-empty" },
      ],
    });
    expect(insertedLogs).toEqual([]);
  });
});
