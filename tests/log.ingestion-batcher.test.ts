import { describe, expect, it, vi } from "vitest";
import { createIngestionBatcher } from "../src/logs/log.ingestion-batcher.js";
import type { ValidatedLog } from "../src/logs/log.types.js";

function log(message: string): ValidatedLog {
  return {
    timestamp: "2026-08-11T12:00:00.000Z",
    level: "info",
    service: "orders",
    message,
    attributes: {},
    attributesSearch: {},
  };
}

describe("ingestion batcher", () => {
  it("coalesces concurrent inserts and resolves after the durable write", async () => {
    const insertLogs = vi.fn().mockResolvedValue(undefined);
    const batcher = createIngestionBatcher(
      { insertLogs },
      { maxLogsPerBatch: 100, maxWaitMs: 1, concurrency: 1 },
    );

    await Promise.all([batcher.insertLogs([log("first")]), batcher.insertLogs([log("second")])]);

    expect(insertLogs).toHaveBeenCalledTimes(1);
    expect(insertLogs).toHaveBeenCalledWith([log("first"), log("second")]);
  });

  it("rejects every request represented by a failed shared write", async () => {
    const error = new Error("database unavailable");
    const batcher = createIngestionBatcher(
      { insertLogs: vi.fn().mockRejectedValue(error) },
      { maxLogsPerBatch: 100, maxWaitMs: 1, concurrency: 1 },
    );

    await expect(
      Promise.all([batcher.insertLogs([log("first")]), batcher.insertLogs([log("second")])]),
    ).rejects.toBe(error);
  });

  it("flushes a partial batch before shutdown", async () => {
    const insertLogs = vi.fn().mockResolvedValue(undefined);
    const batcher = createIngestionBatcher(
      { insertLogs },
      { maxLogsPerBatch: 100, maxWaitMs: 1_000, concurrency: 1 },
    );

    const pending = batcher.insertLogs([log("final")]);
    await batcher.flush();
    await pending;

    expect(insertLogs).toHaveBeenCalledWith([log("final")]);
  });
});
