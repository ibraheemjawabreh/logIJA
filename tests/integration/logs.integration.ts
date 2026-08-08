import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { Pool } from "pg";
import { buildApp } from "../../src/app.js";
import { loadConfig } from "../../src/config.js";
import { runMigrations } from "../../src/database/migrate.js";
import { createLogRepository } from "../../src/logs/log.repository.js";
import { createLogIngestionService } from "../../src/logs/log.service.js";
import { createRetentionRepository } from "../../src/retention/retention.repository.js";
import { createRetentionService } from "../../src/retention/retention.service.js";
import type { AggregateResponse, LogListResponse } from "../../src/logs/log.types.js";

interface PersistedLogRow {
  service: string;
  message: string;
  attributes: Record<string, unknown>;
  attributes_search: Record<string, unknown>;
}

const databaseUrl =
  process.env["INTEGRATION_DATABASE_URL"] ??
  process.env["DATABASE_URL"] ??
  "postgresql://logija:logija@localhost:5432/logija";

const cursorSecret = "integration-test-secret";
const config = loadConfig({
  LOG_LEVEL: "silent",
  DATABASE_URL: databaseUrl,
  CURSOR_SECRET: cursorSecret,
});

describe("logs PostgreSQL integration", () => {
  const prefix = `integration-${randomUUID()}`;
  const checkout = `${prefix}-checkout`;
  const billing = `${prefix}-billing`;
  const inventory = `${prefix}-inventory`;
  const pool = new Pool({ connectionString: databaseUrl });
  let app: FastifyInstance;

  beforeAll(async () => {
    await runMigrations(pool);
    await pool.query("DELETE FROM logs WHERE service LIKE $1", [`${prefix}%`]);

    const repository = createLogRepository(pool);
    const service = createLogIngestionService(repository, {
      now: () => new Date("2026-08-08T00:00:00.000Z"),
      cursorSecret,
    });

    const ingestion = await service.ingestLogs([
      {
        timestamp: "2006-07-20T14:00:00.000Z",
        level: "error",
        service: checkout,
        message: "same timestamp older payment declined",
        attributes: { user_id: "42", retries: 3, success: false, region: "eu-west" },
      },
      {
        timestamp: "2006-07-20T14:00:00.000Z",
        level: "info",
        service: checkout,
        message: "same timestamp newer",
        attributes: { user_id: "42", retries: 4, success: true, region: "eu-west" },
      },
      {
        timestamp: "2006-07-20T14:01:00.000Z",
        level: "error",
        service: billing,
        message: "CARD DECLINED at 100%_literal",
        attributes: { user_id: "7", retries: 2, success: true, region: "us-east" },
      },
      {
        timestamp: "2006-07-20T14:04:59.000Z",
        level: "warn",
        service: checkout,
        message: "near five minute boundary",
        attributes: { user_id: "42", retries: 3, success: false },
      },
      {
        timestamp: "2006-07-20T14:05:00.000Z",
        level: "error",
        service: checkout,
        message: "payment declined again",
        attributes: { user_id: "42", retries: 3, success: false },
      },
      {
        timestamp: "2006-07-20T15:00:00.000Z",
        level: "debug",
        service: inventory,
        message: "stock check",
        attributes: { user_id: "100", retries: 0, success: true },
      },
      {
        timestamp: "2006-07-21T00:00:00.000Z",
        level: "error",
        service: checkout,
        message: "next day payment declined",
        attributes: { user_id: "42", retries: 1, success: false },
      },
    ]);
    expect(ingestion).toEqual({ accepted: 7, rejected: [] });

    app = await buildApp(config, {
      checkDb: async () => true,
      ingestLogs: service.ingestLogs,
      queryLogs: service.queryLogs,
      aggregateLogs: service.aggregateLogs,
    });
  });

  afterAll(async () => {
    await app.close();
    await pool.query("DELETE FROM logs WHERE service LIKE $1", [`${prefix}%`]);
    await pool.end();
  });

  it("persists accepted logs with original attributes and string-normalized attributes_search", async () => {
    const rows = await pool.query<PersistedLogRow>(
      `
        SELECT service, message, attributes, attributes_search
        FROM logs
        WHERE service = $1 AND message = $2
      `,
      [checkout, "payment declined again"],
    );

    expect(rows.rowCount).toBe(1);
    expect(rows.rows[0]).toEqual({
      service: checkout,
      message: "payment declined again",
      attributes: {
        user_id: "42",
        retries: 3,
        success: false,
      },
      attributes_search: {
        user_id: "42",
        retries: "3",
        success: "false",
      },
    });
  });

  it("lists logs by timestamp DESC and id DESC", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/logs?since=2006-07-20T14:00:00Z&until=2006-07-21T00:00:01Z&limit=10",
    });

    expect(res.statusCode).toBe(200);
    expect(res.json<LogListResponse>().logs.map((log) => log.message)).toEqual([
      "next day payment declined",
      "stock check",
      "payment declined again",
      "near five minute boundary",
      "CARD DECLINED at 100%_literal",
      "same timestamp newer",
      "same timestamp older payment declined",
    ]);
  });

  it("filters by exact service and level", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/logs?service=${encodeURIComponent(checkout)}&level=error&since=2006-07-20T14:00:00Z&until=2006-07-21T00:00:01Z`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json<LogListResponse>().logs.map((log) => log.message)).toEqual([
      "next day payment declined",
      "payment declined again",
      "same timestamp older payment declined",
    ]);
  });

  it("applies since inclusively and until exclusively", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/logs?since=2006-07-20T14:00:00Z&until=2006-07-20T14:01:00Z",
    });

    expect(res.statusCode).toBe(200);
    expect(res.json<LogListResponse>().logs.map((log) => log.message)).toEqual([
      "same timestamp newer",
      "same timestamp older payment declined",
    ]);
  });

  it("combines service, level, since, and until filters", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/logs?service=${encodeURIComponent(checkout)}&level=error&since=2006-07-20T14:05:00Z&until=2006-07-21T00:00:01Z`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json<LogListResponse>().logs.map((log) => log.message)).toEqual([
      "next day payment declined",
      "payment declined again",
    ]);
  });

  it("filters attributes using string equality for strings, numbers, and booleans", async () => {
    const numberRes = await app.inject({
      method: "GET",
      url: "/logs?attr.retries=3&since=2006-07-20T14:00:00Z&until=2006-07-20T14:06:00Z",
    });
    const booleanRes = await app.inject({
      method: "GET",
      url: "/logs?attr.success=false&since=2006-07-20T14:00:00Z&until=2006-07-20T14:06:00Z",
    });
    const multiRes = await app.inject({
      method: "GET",
      url: "/logs?attr.user_id=42&attr.region=eu-west&since=2006-07-20T14:00:00Z&until=2006-07-20T14:06:00Z",
    });
    const missingRes = await app.inject({
      method: "GET",
      url: "/logs?attr.missing=value&since=2006-07-20T14:00:00Z&until=2006-07-20T14:06:00Z",
    });

    expect(numberRes.json<LogListResponse>().logs.map((log) => log.message)).toEqual([
      "payment declined again",
      "near five minute boundary",
      "same timestamp older payment declined",
    ]);
    expect(booleanRes.json<LogListResponse>().logs).toHaveLength(3);
    expect(multiRes.json<LogListResponse>().logs.map((log) => log.message)).toEqual([
      "same timestamp newer",
      "same timestamp older payment declined",
    ]);
    expect(missingRes.json<LogListResponse>().logs).toEqual([]);
  });

  it("searches q case-insensitively and treats LIKE wildcards literally", async () => {
    const declinedRes = await app.inject({
      method: "GET",
      url: "/logs?q=declined&since=2006-07-20T14:00:00Z&until=2006-07-20T14:06:00Z",
    });
    const percentRes = await app.inject({
      method: "GET",
      url: "/logs?q=100%25&since=2006-07-20T14:00:00Z&until=2006-07-20T14:06:00Z",
    });
    const underscoreRes = await app.inject({
      method: "GET",
      url: "/logs?q=%5F&since=2006-07-20T14:00:00Z&until=2006-07-20T14:06:00Z",
    });
    const noMatchRes = await app.inject({
      method: "GET",
      url: "/logs?q=not-present&since=2006-07-20T14:00:00Z&until=2006-07-20T14:06:00Z",
    });

    expect(declinedRes.json<LogListResponse>().logs.map((log) => log.message)).toEqual([
      "payment declined again",
      "CARD DECLINED at 100%_literal",
      "same timestamp older payment declined",
    ]);
    expect(percentRes.json<LogListResponse>().logs.map((log) => log.message)).toEqual([
      "CARD DECLINED at 100%_literal",
    ]);
    expect(underscoreRes.json<LogListResponse>().logs.map((log) => log.message)).toEqual([
      "CARD DECLINED at 100%_literal",
    ]);
    expect(noMatchRes.json<LogListResponse>().logs).toEqual([]);
  });

  it("uses cursor pagination without duplicates across pages", async () => {
    const firstPage = await app.inject({
      method: "GET",
      url: "/logs?since=2006-07-20T14:00:00Z&until=2006-07-21T00:00:01Z&limit=2",
    });
    const first = firstPage.json<LogListResponse>();

    expect(first.logs.map((log) => log.message)).toEqual([
      "next day payment declined",
      "stock check",
    ]);
    expect(first.next_cursor).not.toBeNull();

    const secondPage = await app.inject({
      method: "GET",
      url: `/logs?since=2006-07-20T14:00:00Z&until=2006-07-21T00:00:01Z&limit=2&cursor=${encodeURIComponent(first.next_cursor ?? "")}`,
    });
    const second = secondPage.json<LogListResponse>();

    expect(second.logs.map((log) => log.message)).toEqual([
      "payment declined again",
      "near five minute boundary",
    ]);
    expect(new Set([...first.logs, ...second.logs].map((log) => log.id)).size).toBe(4);
  });

  it("paginates same-timestamp rows using id DESC as the tie-breaker", async () => {
    const firstPage = await app.inject({
      method: "GET",
      url: "/logs?since=2006-07-20T14:00:00Z&until=2006-07-20T14:00:01Z&limit=1",
    });
    const first = firstPage.json<LogListResponse>();
    const secondPage = await app.inject({
      method: "GET",
      url: `/logs?since=2006-07-20T14:00:00Z&until=2006-07-20T14:00:01Z&limit=1&cursor=${encodeURIComponent(first.next_cursor ?? "")}`,
    });
    const second = secondPage.json<LogListResponse>();

    expect(first.logs.map((log) => log.message)).toEqual(["same timestamp newer"]);
    expect(second.logs.map((log) => log.message)).toEqual([
      "same timestamp older payment declined",
    ]);
    expect(second.next_cursor).toBeNull();
  });

  it("treats suspicious query values as literal values", async () => {
    const serviceRes = await app.inject({
      method: "GET",
      url: "/logs?service=%27%20OR%201%3D1%20--&since=2006-07-20T14:00:00Z&until=2006-07-21T00:00:01Z",
    });
    const qRes = await app.inject({
      method: "GET",
      url: "/logs?q=%25%27%20OR%20true%20--&since=2006-07-20T14:00:00Z&until=2006-07-21T00:00:01Z",
    });
    const attrRes = await app.inject({
      method: "GET",
      url: "/logs?attr.user_id=%27%20OR%20%271%27%3D%271&since=2006-07-20T14:00:00Z&until=2006-07-21T00:00:01Z",
    });

    expect(serviceRes.json<LogListResponse>().logs).toEqual([]);
    expect(qRes.json<LogListResponse>().logs).toEqual([]);
    expect(attrRes.json<LogListResponse>().logs).toEqual([]);
  });

  it("aggregates into 1m, 5m, 1h, and 1d buckets", async () => {
    const oneMinute = await app.inject({
      method: "GET",
      url: "/logs/aggregate?since=2006-07-20T14:00:00Z&until=2006-07-20T14:06:00Z&bucket=1m",
    });
    const fiveMinute = await app.inject({
      method: "GET",
      url: "/logs/aggregate?since=2006-07-20T14:00:00Z&until=2006-07-20T14:06:00Z&bucket=5m",
    });
    const oneHour = await app.inject({
      method: "GET",
      url: "/logs/aggregate?since=2006-07-20T14:00:00Z&until=2006-07-20T15:01:00Z&bucket=1h",
    });
    const oneDay = await app.inject({
      method: "GET",
      url: "/logs/aggregate?since=2006-07-20T00:00:00Z&until=2006-07-22T00:00:00Z&bucket=1d",
    });

    expect(oneMinute.json<AggregateResponse>().buckets).toEqual([
      { start: "2006-07-20T14:00:00.000Z", group: null, count: 2 },
      { start: "2006-07-20T14:01:00.000Z", group: null, count: 1 },
      { start: "2006-07-20T14:04:00.000Z", group: null, count: 1 },
      { start: "2006-07-20T14:05:00.000Z", group: null, count: 1 },
    ]);
    expect(fiveMinute.json<AggregateResponse>().buckets).toEqual([
      { start: "2006-07-20T14:00:00.000Z", group: null, count: 4 },
      { start: "2006-07-20T14:05:00.000Z", group: null, count: 1 },
    ]);
    expect(oneHour.json<AggregateResponse>().buckets).toEqual([
      { start: "2006-07-20T14:00:00.000Z", group: null, count: 5 },
      { start: "2006-07-20T15:00:00.000Z", group: null, count: 1 },
    ]);
    expect(oneDay.json<AggregateResponse>().buckets).toEqual([
      { start: "2006-07-20T00:00:00.000Z", group: null, count: 6 },
      { start: "2006-07-21T00:00:00.000Z", group: null, count: 1 },
    ]);
  });

  it("aggregates with group_by service and level", async () => {
    const byService = await app.inject({
      method: "GET",
      url: "/logs/aggregate?since=2006-07-20T14:00:00Z&until=2006-07-20T14:06:00Z&bucket=5m&group_by=service",
    });
    const byLevel = await app.inject({
      method: "GET",
      url: "/logs/aggregate?since=2006-07-20T14:00:00Z&until=2006-07-20T14:06:00Z&bucket=5m&group_by=level",
    });

    expect(byService.json<AggregateResponse>().buckets).toEqual([
      { start: "2006-07-20T14:00:00.000Z", group: billing, count: 1 },
      { start: "2006-07-20T14:00:00.000Z", group: checkout, count: 3 },
      { start: "2006-07-20T14:05:00.000Z", group: checkout, count: 1 },
    ]);
    expect(byLevel.json<AggregateResponse>().buckets).toEqual([
      { start: "2006-07-20T14:00:00.000Z", group: "error", count: 2 },
      { start: "2006-07-20T14:00:00.000Z", group: "info", count: 1 },
      { start: "2006-07-20T14:00:00.000Z", group: "warn", count: 1 },
      { start: "2006-07-20T14:05:00.000Z", group: "error", count: 1 },
    ]);
  });

  it("combines filters with aggregation", async () => {
    const serviceLevel = await app.inject({
      method: "GET",
      url: `/logs/aggregate?service=${encodeURIComponent(checkout)}&level=error&since=2006-07-20T14:00:00Z&until=2006-07-21T00:00:01Z&bucket=1h`,
    });
    const attrFilter = await app.inject({
      method: "GET",
      url: "/logs/aggregate?attr.success=false&since=2006-07-20T14:00:00Z&until=2006-07-20T14:06:00Z&bucket=5m",
    });
    const qFilter = await app.inject({
      method: "GET",
      url: "/logs/aggregate?q=declined&since=2006-07-20T14:00:00Z&until=2006-07-20T14:06:00Z&bucket=5m",
    });
    const empty = await app.inject({
      method: "GET",
      url: "/logs/aggregate?service=no-such-service&since=2006-07-20T14:00:00Z&until=2006-07-20T14:06:00Z&bucket=1m",
    });

    expect(serviceLevel.json<AggregateResponse>().buckets).toEqual([
      { start: "2006-07-20T14:00:00.000Z", group: null, count: 2 },
      { start: "2006-07-21T00:00:00.000Z", group: null, count: 1 },
    ]);
    expect(attrFilter.json<AggregateResponse>().buckets).toEqual([
      { start: "2006-07-20T14:00:00.000Z", group: null, count: 2 },
      { start: "2006-07-20T14:05:00.000Z", group: null, count: 1 },
    ]);
    expect(qFilter.json<AggregateResponse>().buckets).toEqual([
      { start: "2006-07-20T14:00:00.000Z", group: null, count: 2 },
      { start: "2006-07-20T14:05:00.000Z", group: null, count: 1 },
    ]);
    expect(empty.json<AggregateResponse>()).toEqual({ buckets: [] });
  });

  it("deletes expired rows in real PostgreSQL batches while keeping non-expired rows", async () => {
    const retentionExpired = `${prefix}-retention-expired`;
    const retentionFresh = `${prefix}-retention-fresh`;
    const repository = createLogRepository(pool);
    const ingestionService = createLogIngestionService(repository, {
      now: () => new Date("2026-08-08T00:00:00.000Z"),
      cursorSecret,
    });
    await ingestionService.ingestLogs([
      {
        timestamp: "2000-01-01T00:00:00.000Z",
        level: "info",
        service: retentionExpired,
        message: "expired one",
        attributes: {},
      },
      {
        timestamp: "2000-01-01T00:00:01.000Z",
        level: "info",
        service: retentionExpired,
        message: "expired two",
        attributes: {},
      },
      {
        timestamp: "2026-08-07T00:00:00.000Z",
        level: "info",
        service: retentionFresh,
        message: "fresh",
        attributes: {},
      },
    ]);

    const retentionService = createRetentionService(createRetentionRepository(pool), {
      retentionDays: 8_000,
      intervalSeconds: 60,
      batchSize: 1,
      maxBatchesPerCycle: 10,
      now: () => new Date("2026-08-08T00:00:00.000Z"),
    });

    await expect(retentionService.cleanupExpiredLogs()).resolves.toMatchObject({
      deleted: 2,
      batches: 2,
      hasMore: false,
    });

    const remaining = await pool.query<{ service: string; count: string }>(
      `
        SELECT service, COUNT(*)::text AS count
        FROM logs
        WHERE service IN ($1, $2)
        GROUP BY service
        ORDER BY service
      `,
      [retentionExpired, retentionFresh],
    );

    expect(remaining.rows).toEqual([{ service: retentionFresh, count: "1" }]);
  });
});
