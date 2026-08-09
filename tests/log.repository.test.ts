import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { createLogRepository } from "../src/logs/log.repository.js";
import type { ValidatedLog } from "../src/logs/log.types.js";

const logs: ValidatedLog[] = [
  {
    timestamp: "2026-08-09T12:00:00.000Z",
    level: "error",
    service: "checkout",
    message: "payment declined",
    attributes: { retries: 3, success: false },
    attributesSearch: { retries: "3", success: "false" },
  },
  {
    timestamp: "2026-08-09T12:00:01.000Z",
    level: "info",
    service: "orders",
    message: "order queued",
    attributes: { attempts: 1 },
    attributesSearch: { attempts: "1" },
  },
];

function poolWithQuery(): { pool: Pool; query: ReturnType<typeof vi.fn> } {
  const query = vi.fn().mockResolvedValue({ rows: [] });
  return { pool: { query } as unknown as Pool, query };
}

describe("log repository insertion strategies", () => {
  it("uses one parameterized multi-row INSERT", async () => {
    const { pool, query } = poolWithQuery();

    await createLogRepository(pool, "multirow").insertLogs(logs);

    expect(query).toHaveBeenCalledTimes(1);
    const [text, values] = query.mock.calls[0] as [string, unknown[]];
    expect(text).toContain(
      "INSERT INTO logs (timestamp, level, service, message, attributes, attributes_search) VALUES",
    );
    expect(text).toContain("$5::jsonb");
    expect(text).toContain("$12::jsonb");
    expect(text).not.toContain("payment declined");
    expect(values).toEqual([
      "2026-08-09T12:00:00.000Z",
      "error",
      "checkout",
      "payment declined",
      '{"retries":3,"success":false}',
      '{"retries":"3","success":"false"}',
      "2026-08-09T12:00:01.000Z",
      "info",
      "orders",
      "order queued",
      '{"attempts":1}',
      '{"attempts":"1"}',
    ]);
  });

  it("uses a fixed UNNEST statement with typed arrays", async () => {
    const { pool, query } = poolWithQuery();

    await createLogRepository(pool, "unnest").insertLogs(logs);

    expect(query).toHaveBeenCalledTimes(1);
    const [text, values] = query.mock.calls[0] as [string, unknown[]];
    expect(text).toContain("FROM unnest(");
    expect(text).toContain("$1::timestamptz[]");
    expect(text).toContain("$5::jsonb[]");
    expect(text).not.toContain("payment declined");
    expect(values).toEqual([
      ["2026-08-09T12:00:00.000Z", "2026-08-09T12:00:01.000Z"],
      ["error", "info"],
      ["checkout", "orders"],
      ["payment declined", "order queued"],
      ['{"retries":3,"success":false}', '{"attempts":1}'],
      ['{"retries":"3","success":"false"}', '{"attempts":"1"}'],
    ]);
  });
});
