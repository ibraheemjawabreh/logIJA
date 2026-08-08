import { describe, expect, it } from "vitest";
import { encodeCursor } from "../src/logs/log.cursor.js";
import {
  DEFAULT_LOG_QUERY_LIMIT,
  MAX_LOG_QUERY_LIMIT,
  parseAggregateQuery,
  parseLogQuery,
} from "../src/logs/log.query-validation.js";

const secret = "query-validation-secret";

describe("parseLogQuery", () => {
  it("parses defaults and supported filters", () => {
    const cursor = encodeCursor({ timestamp: "2026-07-20T14:32:01.123Z", id: "99" }, secret);

    expect(
      parseLogQuery(
        {
          service: "checkout",
          level: "error",
          since: "2026-07-20T14:00:00Z",
          until: "2026-07-20T15:00:00Z",
          "attr.user_id": "42",
          "attr.retries": "3",
          q: "declined",
          limit: "500",
          cursor,
        },
        secret,
      ),
    ).toEqual({
      ok: true,
      value: {
        service: "checkout",
        level: "error",
        since: "2026-07-20T14:00:00.000Z",
        until: "2026-07-20T15:00:00.000Z",
        attributes: [
          { key: "user_id", value: "42" },
          { key: "retries", value: "3" },
        ],
        q: "declined",
        limit: 500,
        cursor: { timestamp: "2026-07-20T14:32:01.123Z", id: "99" },
      },
    });
  });

  it("uses the default limit", () => {
    expect(parseLogQuery({}, secret)).toEqual({
      ok: true,
      value: { attributes: [], limit: DEFAULT_LOG_QUERY_LIMIT },
    });
  });

  it("accepts the maximum limit", () => {
    expect(parseLogQuery({ limit: String(MAX_LOG_QUERY_LIMIT) }, secret)).toEqual({
      ok: true,
      value: { attributes: [], limit: MAX_LOG_QUERY_LIMIT },
    });
  });

  it.each([
    [{ level: "critical" }, "invalid level: 'critical'"],
    [{ since: "2026-02-30T00:00:00Z" }, "invalid since"],
    [{ until: "not-a-date" }, "invalid until"],
    [
      { since: "2026-07-20T15:00:00Z", until: "2026-07-20T15:00:00Z" },
      "until must be strictly later than since",
    ],
    [{ limit: "abc" }, "limit must be an integer between 1 and 1000"],
    [{ limit: "1.5" }, "limit must be an integer between 1 and 1000"],
    [{ limit: "0" }, "limit must be an integer between 1 and 1000"],
    [{ limit: "1001" }, "limit must be an integer between 1 and 1000"],
    [{ cursor: "not-a-cursor" }, "malformed cursor"],
    [{ "attr.": "42" }, "malformed attr key"],
    [{ "attr.bad key": "42" }, "malformed attr key"],
    [{ service: ["checkout", "billing"] }, "service must be provided only once"],
  ])("rejects invalid query %#", (query, error) => {
    expect(parseLogQuery(query, secret)).toEqual({ ok: false, error });
  });

  it("rejects tampered signed cursors", () => {
    const cursor = encodeCursor({ timestamp: "2026-07-20T14:32:01.123Z", id: "99" }, secret);
    const tampered = `${cursor.slice(0, -1)}${cursor.at(-1) === "A" ? "B" : "A"}`;

    expect(parseLogQuery({ cursor: tampered }, secret)).toEqual({
      ok: false,
      error: "malformed cursor",
    });
  });
});

describe("parseAggregateQuery", () => {
  it("parses required aggregate parameters and optional filters", () => {
    expect(
      parseAggregateQuery({
        since: "2026-07-20T14:00:00Z",
        until: "2026-07-20T15:00:00Z",
        bucket: "5m",
        group_by: "service",
        service: "checkout",
        level: "error",
        "attr.user_id": "42",
        q: "declined",
      }),
    ).toEqual({
      ok: true,
      value: {
        since: "2026-07-20T14:00:00.000Z",
        until: "2026-07-20T15:00:00.000Z",
        bucket: "5m",
        groupBy: "service",
        service: "checkout",
        level: "error",
        attributes: [{ key: "user_id", value: "42" }],
        q: "declined",
      },
    });
  });

  it.each([
    [{ until: "2026-07-20T15:00:00Z", bucket: "1m" }, "since is required"],
    [{ since: "2026-07-20T14:00:00Z", bucket: "1m" }, "until is required"],
    [{ since: "2026-07-20T14:00:00Z", until: "2026-07-20T15:00:00Z" }, "bucket is required"],
    [
      { since: "2026-07-20T14:00:00Z", until: "2026-07-20T15:00:00Z", bucket: "10m" },
      "invalid bucket",
    ],
    [
      {
        since: "2026-07-20T14:00:00Z",
        until: "2026-07-20T15:00:00Z",
        bucket: "1m",
        group_by: "message",
      },
      "invalid group_by",
    ],
    [
      { since: "2026-07-20T15:00:00Z", until: "2026-07-20T14:00:00Z", bucket: "1m" },
      "until must be strictly later than since",
    ],
  ])("rejects invalid aggregate query %#", (query, error) => {
    expect(parseAggregateQuery(query)).toEqual({ ok: false, error });
  });
});
