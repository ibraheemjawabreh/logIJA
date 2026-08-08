import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import type {
  AggregateResponse,
  IngestionResult,
  LogListResponse,
  ValidatedAggregateQuery,
  ValidatedLogQuery,
} from "../src/logs/log.types.js";

const config = loadConfig({ LOG_LEVEL: "silent", CURSOR_SECRET: "route-query-secret" });
const checkDb = async (): Promise<boolean> => true;
const ingestLogs = async (): Promise<IngestionResult> => ({ accepted: 0, rejected: [] });

describe("GET /logs routes", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    await app.close();
  });

  it("parses query parameters and returns list responses", async () => {
    let captured: ValidatedLogQuery | null = null;
    const queryLogs = async (query: ValidatedLogQuery): Promise<LogListResponse> => {
      captured = query;
      return {
        logs: [
          {
            id: "1",
            timestamp: "2026-07-20T14:32:01.123Z",
            level: "error",
            service: "checkout",
            message: "payment declined",
            attributes: { user_id: "42" },
          },
        ],
        next_cursor: null,
      };
    };
    const aggregateLogs = async (): Promise<AggregateResponse> => ({ buckets: [] });
    app = await buildApp(config, { checkDb, ingestLogs, queryLogs, aggregateLogs });

    const res = await app.inject({
      method: "GET",
      url: "/logs?service=checkout&level=error&since=2026-07-20T14:00:00Z&until=2026-07-20T15:00:00Z&attr.user_id=42&q=declined&limit=10",
    });

    expect(res.statusCode).toBe(200);
    expect(res.json<LogListResponse>().logs).toHaveLength(1);
    expect(captured).toMatchObject({
      service: "checkout",
      level: "error",
      since: "2026-07-20T14:00:00.000Z",
      until: "2026-07-20T15:00:00.000Z",
      attributes: [{ key: "user_id", value: "42" }],
      q: "declined",
      limit: 10,
    });
  });

  it.each([
    "/logs?since=not-a-date",
    "/logs?until=not-a-date",
    "/logs?since=2026-07-20T15:00:00Z&until=2026-07-20T14:00:00Z",
    "/logs?level=critical",
    "/logs?limit=abc",
    "/logs?limit=1.5",
    "/logs?limit=0",
    "/logs?limit=1001",
    "/logs?cursor=bad",
    "/logs?attr.=42",
  ])("returns HTTP 400 for invalid query %s", async (url) => {
    const queryLogs = async (): Promise<LogListResponse> => ({ logs: [], next_cursor: null });
    const aggregateLogs = async (): Promise<AggregateResponse> => ({ buckets: [] });
    app = await buildApp(config, { checkDb, ingestLogs, queryLogs, aggregateLogs });

    const res = await app.inject({ method: "GET", url });

    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>()).toHaveProperty("error");
  });

  it("parses aggregate query parameters and returns bucket responses", async () => {
    const queryLogs = async (): Promise<LogListResponse> => ({ logs: [], next_cursor: null });
    let captured: ValidatedAggregateQuery | null = null;
    const aggregateLogs = async (query: ValidatedAggregateQuery): Promise<AggregateResponse> => {
      captured = query;
      return { buckets: [{ start: "2026-07-20T14:00:00.000Z", group: "checkout", count: 2 }] };
    };
    app = await buildApp(config, { checkDb, ingestLogs, queryLogs, aggregateLogs });

    const res = await app.inject({
      method: "GET",
      url: "/logs/aggregate?since=2026-07-20T14:00:00Z&until=2026-07-20T15:00:00Z&bucket=1m&group_by=service&attr.user_id=42&q=declined",
    });

    expect(res.statusCode).toBe(200);
    expect(res.json<AggregateResponse>()).toEqual({
      buckets: [{ start: "2026-07-20T14:00:00.000Z", group: "checkout", count: 2 }],
    });
    expect(captured).toMatchObject({
      since: "2026-07-20T14:00:00.000Z",
      until: "2026-07-20T15:00:00.000Z",
      bucket: "1m",
      groupBy: "service",
      attributes: [{ key: "user_id", value: "42" }],
      q: "declined",
    });
  });

  it.each([
    "/logs/aggregate?until=2026-07-20T15:00:00Z&bucket=1m",
    "/logs/aggregate?since=2026-07-20T14:00:00Z&bucket=1m",
    "/logs/aggregate?since=2026-07-20T14:00:00Z&until=2026-07-20T15:00:00Z",
    "/logs/aggregate?since=2026-07-20T14:00:00Z&until=2026-07-20T15:00:00Z&bucket=10m",
    "/logs/aggregate?since=2026-07-20T14:00:00Z&until=2026-07-20T15:00:00Z&bucket=1m&group_by=message",
  ])("returns HTTP 400 for invalid aggregate query %s", async (url) => {
    const queryLogs = async (): Promise<LogListResponse> => ({ logs: [], next_cursor: null });
    const aggregateLogs = async (): Promise<AggregateResponse> => ({ buckets: [] });
    app = await buildApp(config, { checkDb, ingestLogs, queryLogs, aggregateLogs });

    const res = await app.inject({ method: "GET", url });

    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>()).toHaveProperty("error");
  });
});
