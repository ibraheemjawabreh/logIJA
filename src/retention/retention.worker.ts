import type { RetentionLogger } from "./retention.types.js";
import type { RetentionService } from "./retention.service.js";

interface TimerApi {
  setInterval: (callback: () => void, milliseconds: number) => NodeJS.Timeout;
  clearInterval: (handle: NodeJS.Timeout) => void;
}

export interface RetentionWorkerOptions {
  intervalSeconds: number;
  logger: RetentionLogger;
  timers?: TimerApi;
}

export interface RetentionWorker {
  start: () => void;
  stop: () => void;
  runOnce: () => Promise<void>;
  isRunning: () => boolean;
}

export function createRetentionWorker(
  service: RetentionService,
  options: RetentionWorkerOptions,
): RetentionWorker {
  const timers = options.timers ?? {
    setInterval: global.setInterval,
    clearInterval: global.clearInterval,
  };
  let handle: NodeJS.Timeout | null = null;
  let running = false;

  async function runOnce(): Promise<void> {
    if (running) {
      options.logger.info("Retention cycle skipped because a previous cycle is still running");
      return;
    }

    running = true;
    try {
      const result = await service.cleanupExpiredLogs();
      options.logger.info("Retention cycle completed", {
        cutoff: result.cutoff,
        deleted: result.deleted,
        batches: result.batches,
        hasMore: result.hasMore,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      options.logger.error("Retention cycle failed", { error: message });
    } finally {
      running = false;
    }
  }

  return {
    start(): void {
      if (handle !== null) {
        return;
      }
      void runOnce();
      handle = timers.setInterval(() => {
        void runOnce();
      }, options.intervalSeconds * 1_000);
    },

    stop(): void {
      if (handle === null) {
        return;
      }
      timers.clearInterval(handle);
      handle = null;
    },

    runOnce,

    isRunning(): boolean {
      return running;
    },
  };
}
