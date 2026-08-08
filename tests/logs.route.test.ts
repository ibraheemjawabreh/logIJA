import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import type { AggregateResponse, IngestionResult, LogListResponse } from "../src/logs/log.types.js";
import { MAX_LOGS_PER_BATCH } from "../src/logs/log.validation.js";

const config = loadConfig({ LOG_LEVEL: "silent" });
const checkDb = async (): Promise<boolean> => true;

function validLog(message = "payment declined"): Record<string, unknown> {
  return {
    timestamp: "2026-07-20T14:32:01.123Z",
    level: "error",
    service: "checkout",
    message,
    attributes: { user_id: "42", retries: 3 },
  };
}

function createApp(
  ingestLogs: (rawLogs: readonly unknown[]) => Promise<IngestionResult>,
): Promise<FastifyInstance> {
  const queryLogs = async (): Promise<LogListResponse> => ({ logs: [], next_cursor: null });
  const aggregateLogs = async (): Promise<AggregateResponse> => ({ buckets: [] });
  return buildApp(config, { checkDb, ingestLogs, queryLogs, aggregateLogs });
}

describe("POST /logs", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    await app.close();
  });

  it("accepts an all-valid batch", async () => {
    app = await createApp(async (rawLogs) => ({ accepted: rawLogs.length, rejected: [] }));

    const res = await app.inject({
      method: "POST",
      url: "/logs",
      payload: { logs: [validLog("one"), validLog("two"), validLog("three")] },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json<IngestionResult>()).toEqual({ accepted: 3, rejected: [] });
  });

  it("partially accepts a mixed-validity batch", async () => {
    app = await createApp(async () => ({
      accepted: 2,
      rejected: [{ index: 1, reason: "invalid level: 'critical'" }],
    }));

    const res = await app.inject({
      method: "POST",
      url: "/logs",
      payload: {
        logs: [validLog("one"), { ...validLog("two"), level: "critical" }, validLog("three")],
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json<IngestionResult>()).toEqual({
      accepted: 2,
      rejected: [{ index: 1, reason: "invalid level: 'critical'" }],
    });
  });

  it("returns 400 when every submitted log is invalid", async () => {
    app = await createApp(async () => ({
      accepted: 0,
      rejected: [
        { index: 0, reason: "invalid level: 'critical'" },
        { index: 1, reason: "message must be non-empty" },
      ],
    }));

    const res = await app.inject({
      method: "POST",
      url: "/logs",
      payload: {
        logs: [
          { ...validLog("one"), level: "critical" },
          { ...validLog(""), message: "" },
        ],
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json<IngestionResult>()).toEqual({
      accepted: 0,
      rejected: [
        { index: 0, reason: "invalid level: 'critical'" },
        { index: 1, reason: "message must be non-empty" },
      ],
    });
  });

  it("returns 400 for malformed top-level bodies", async () => {
    app = await createApp(async () => ({ accepted: 0, rejected: [] }));

    const missingLogs = await app.inject({ method: "POST", url: "/logs", payload: {} });
    const logsNotArray = await app.inject({
      method: "POST",
      url: "/logs",
      payload: { logs: "not-array" },
    });

    expect(missingLogs.statusCode).toBe(400);
    expect(missingLogs.json<{ error: string }>()).toEqual({
      error: "request body must be an object with a logs array",
    });
    expect(logsNotArray.statusCode).toBe(400);
    expect(logsNotArray.json<{ error: string }>()).toEqual({
      error: "request body must be an object with a logs array",
    });
  });

  it("returns 400 for an empty batch", async () => {
    app = await createApp(async () => ({ accepted: 0, rejected: [] }));

    const res = await app.inject({ method: "POST", url: "/logs", payload: { logs: [] } });

    expect(res.statusCode).toBe(400);
    expect(res.json<IngestionResult>()).toEqual({
      accepted: 0,
      rejected: [{ index: -1, reason: "logs must contain at least one entry" }],
    });
  });

  it("returns 413 when the batch exceeds the maximum log count", async () => {
    app = await createApp(async () => ({ accepted: 0, rejected: [] }));

    const res = await app.inject({
      method: "POST",
      url: "/logs",
      payload: { logs: Array.from({ length: MAX_LOGS_PER_BATCH + 1 }, () => null) },
    });

    expect(res.statusCode).toBe(413);
    expect(res.json<{ error: string }>()).toEqual({
      error: `logs batch exceeds maximum of ${MAX_LOGS_PER_BATCH}`,
    });
  });

  it("tolerates unknown log fields because they are ignored by validation", async () => {
    app = await createApp(async () => ({ accepted: 1, rejected: [] }));

    const res = await app.inject({
      method: "POST",
      url: "/logs",
      payload: { logs: [{ ...validLog(), trace_id: "abc-123" }] },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json<IngestionResult>()).toEqual({ accepted: 1, rejected: [] });
  });

  it("returns a safe 500 response when persistence fails", async () => {
    app = await createApp(async () => {
      throw new Error("duplicate key value violates constraint logs_pkey");
    });

    const res = await app.inject({ method: "POST", url: "/logs", payload: { logs: [validLog()] } });

    expect(res.statusCode).toBe(500);
    expect(res.json<{ error: string }>()).toEqual({ error: "internal server error" });
  });

  it("returns a controlled 400 for malformed JSON", async () => {
    app = await createApp(async () => ({ accepted: 0, rejected: [] }));

    const res = await app.inject({
      method: "POST",
      url: "/logs",
      payload: '{"logs":[',
      headers: { "content-type": "application/json" },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>()).toHaveProperty("error");
  });
});
