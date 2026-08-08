import { describe, expect, it } from "vitest";
import { createRetentionWorker } from "../src/retention/retention.worker.js";
import type { RetentionLogger } from "../src/retention/retention.types.js";

function logger(messages: string[]): RetentionLogger {
  return {
    info: (message) => messages.push(message),
    error: (message) => messages.push(message),
  };
}

describe("retention worker", () => {
  it("does not overlap cycles", async () => {
    const messages: string[] = [];
    let release: () => void = () => undefined;
    let calls = 0;
    const worker = createRetentionWorker(
      {
        cleanupExpiredLogs: async () => {
          calls += 1;
          await new Promise<void>((resolve) => {
            release = resolve;
          });
          return { cutoff: "2026-07-01T00:00:00.000Z", deleted: 0, batches: 0, hasMore: false };
        },
      },
      { intervalSeconds: 60, logger: logger(messages) },
    );

    const first = worker.runOnce();
    await worker.runOnce();
    release();
    await first;

    expect(calls).toBe(1);
    expect(messages).toContain("Retention cycle skipped because a previous cycle is still running");
  });

  it("starts and stops its interval cleanly", () => {
    const messages: string[] = [];
    let intervalCallback: (() => void) | null = null;
    let cleared = false;
    const fakeHandle = Symbol("handle") as unknown as NodeJS.Timeout;
    const worker = createRetentionWorker(
      {
        cleanupExpiredLogs: async () => ({
          cutoff: "2026-07-01T00:00:00.000Z",
          deleted: 0,
          batches: 0,
          hasMore: false,
        }),
      },
      {
        intervalSeconds: 60,
        logger: logger(messages),
        timers: {
          setInterval: (callback) => {
            intervalCallback = callback;
            return fakeHandle;
          },
          clearInterval: (handle) => {
            cleared = handle === fakeHandle;
          },
        },
      },
    );

    worker.start();
    expect(intervalCallback).not.toBeNull();
    worker.stop();
    expect(cleared).toBe(true);
  });
});
