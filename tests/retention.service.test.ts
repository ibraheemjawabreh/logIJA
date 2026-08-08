import { describe, expect, it } from "vitest";
import { createRetentionService } from "../src/retention/retention.service.js";
import type { RetentionRepository } from "../src/retention/retention.types.js";

describe("retention service", () => {
  it("deletes expired rows in bounded batches until empty", async () => {
    const calls: Array<{ cutoff: string; batchSize: number }> = [];
    const deletedByCall = [2, 2, 1];
    const repository: RetentionRepository = {
      deleteExpiredBatch: async (cutoff, batchSize) => {
        calls.push({ cutoff, batchSize });
        return deletedByCall.shift() ?? 0;
      },
    };
    const service = createRetentionService(repository, {
      retentionDays: 30,
      intervalSeconds: 60,
      batchSize: 2,
      maxBatchesPerCycle: 10,
      now: () => new Date("2026-08-08T00:00:00.000Z"),
    });

    await expect(service.cleanupExpiredLogs()).resolves.toEqual({
      cutoff: "2026-07-09T00:00:00.000Z",
      deleted: 5,
      batches: 3,
      hasMore: false,
    });
    expect(calls).toEqual([
      { cutoff: "2026-07-09T00:00:00.000Z", batchSize: 2 },
      { cutoff: "2026-07-09T00:00:00.000Z", batchSize: 2 },
      { cutoff: "2026-07-09T00:00:00.000Z", batchSize: 2 },
    ]);
  });

  it("stops at the per-cycle batch limit", async () => {
    let calls = 0;
    const repository: RetentionRepository = {
      deleteExpiredBatch: async () => {
        calls += 1;
        return 10;
      },
    };
    const service = createRetentionService(repository, {
      retentionDays: 1,
      intervalSeconds: 60,
      batchSize: 10,
      maxBatchesPerCycle: 2,
      now: () => new Date("2026-08-08T00:00:00.000Z"),
    });

    await expect(service.cleanupExpiredLogs()).resolves.toMatchObject({
      deleted: 20,
      batches: 2,
      hasMore: true,
    });
    expect(calls).toBe(2);
  });

  it("succeeds when there are no expired rows", async () => {
    const repository: RetentionRepository = {
      deleteExpiredBatch: async () => 0,
    };
    const service = createRetentionService(repository, {
      retentionDays: 1,
      intervalSeconds: 60,
      batchSize: 10,
      maxBatchesPerCycle: 2,
      now: () => new Date("2026-08-08T00:00:00.000Z"),
    });

    await expect(service.cleanupExpiredLogs()).resolves.toMatchObject({
      deleted: 0,
      batches: 0,
      hasMore: false,
    });
  });
});
