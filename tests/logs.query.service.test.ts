import { describe, expect, it } from "vitest";
import { decodeCursor } from "../src/logs/log.cursor.js";
import { createLogIngestionService } from "../src/logs/log.service.js";
import type { LogRepository, PersistedLog } from "../src/logs/log.types.js";

const secret = "query-service-secret";

function row(id: string, timestamp: string): PersistedLog {
  return {
    id,
    timestamp,
    level: "error",
    service: "checkout",
    message: `message ${id}`,
    attributes: {},
  };
}

describe("queryLogs service pagination", () => {
  it("returns limit rows and creates a cursor from the last returned row", async () => {
    const repository: LogRepository = {
      insertLogs: async () => undefined,
      listLogs: async () => [
        row("3", "2026-07-20T14:00:03.000Z"),
        row("2", "2026-07-20T14:00:02.000Z"),
        row("1", "2026-07-20T14:00:01.000Z"),
      ],
      aggregateLogs: async () => [],
    };
    const service = createLogIngestionService(repository, { cursorSecret: secret });

    const result = await service.queryLogs({ attributes: [], limit: 2 });

    expect(result.logs.map((log) => log.id)).toEqual(["3", "2"]);
    expect(result.next_cursor).not.toBeNull();
    expect(decodeCursor(result.next_cursor ?? "", secret)).toEqual({
      timestamp: "2026-07-20T14:00:02.000Z",
      id: "2",
    });
  });

  it("returns null cursor on the final page", async () => {
    const repository: LogRepository = {
      insertLogs: async () => undefined,
      listLogs: async () => [row("1", "2026-07-20T14:00:01.000Z")],
      aggregateLogs: async () => [],
    };
    const service = createLogIngestionService(repository, { cursorSecret: secret });

    await expect(service.queryLogs({ attributes: [], limit: 2 })).resolves.toEqual({
      logs: [row("1", "2026-07-20T14:00:01.000Z")],
      next_cursor: null,
    });
  });
});
