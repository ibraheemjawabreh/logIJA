import { describe, expect, it } from "vitest";
import {
  buildAggregateLogsQuery,
  buildListLogsQuery,
  escapeLikeLiteral,
} from "../src/logs/log.query-builder.js";

describe("log query builder", () => {
  it("keeps suspicious values as parameters", () => {
    const query = buildListLogsQuery({
      service: "' OR 1=1 --",
      attributes: [{ key: "user_id", value: "' OR '1'='1" }],
      q: "%' OR true --",
      limit: 10,
    });

    expect(query.text).not.toContain("' OR 1=1 --");
    expect(query.text).not.toContain("' OR '1'='1");
    expect(query.text).not.toContain("%' OR true --");
    expect(query.values).toContain("' OR 1=1 --");
    expect(query.values).toContain("user_id");
    expect(query.values).toContain("' OR '1'='1");
    expect(query.values).toContain("%\\%' OR true --%");
  });

  it("escapes LIKE wildcard characters for literal substring search", () => {
    expect(escapeLikeLiteral("100%_done\\ok")).toBe("100\\%\\_done\\\\ok");
  });

  it("uses keyset ordering without OFFSET", () => {
    const query = buildListLogsQuery({
      cursor: { timestamp: "2026-07-20T14:32:01.123Z", id: "42" },
      attributes: [],
      limit: 100,
    });

    expect(query.text).toContain("ORDER BY timestamp DESC, id DESC");
    expect(query.text).not.toContain("OFFSET");
    expect(query.text).toContain("id <");
  });

  it("maps aggregate bucket and group enums to static SQL", () => {
    const query = buildAggregateLogsQuery({
      since: "2026-07-20T14:00:00.000Z",
      until: "2026-07-20T15:00:00.000Z",
      bucket: "5m",
      groupBy: "level",
      attributes: [],
    });

    expect(query.text).toContain("'5 minutes'::interval");
    expect(query.text).toContain('level AS "group"');
    expect(query.values).toEqual(["2026-07-20T14:00:00.000Z", "2026-07-20T15:00:00.000Z"]);
  });
});
