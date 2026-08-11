import type { LogRepository, ValidatedLog } from "./log.types.js";

export interface IngestionBatcherOptions {
  maxLogsPerBatch: number;
  maxWaitMs: number;
  concurrency: number;
}

export interface IngestionBatcher {
  insertLogs: (logs: readonly ValidatedLog[]) => Promise<void>;
  flush: () => Promise<void>;
}

interface PendingInsert {
  logs: readonly ValidatedLog[];
  resolve: () => void;
  reject: (error: unknown) => void;
}

interface PendingBatch {
  logs: ValidatedLog[];
  inserts: PendingInsert[];
}

/**
 * Coalesces concurrent HTTP ingestion requests into bounded, durable database
 * writes. Each caller settles only after the shared INSERT has committed.
 */
export function createIngestionBatcher(
  repository: Pick<LogRepository, "insertLogs">,
  options: IngestionBatcherOptions,
): IngestionBatcher {
  const pending: PendingInsert[] = [];
  const idleWaiters: Array<() => void> = [];
  let pendingLogCount = 0;
  let activeBatches = 0;
  let flushTimer: ReturnType<typeof setTimeout> | undefined;

  function isIdle(): boolean {
    return pending.length === 0 && activeBatches === 0;
  }

  function resolveIdleWaiters(): void {
    if (!isIdle()) return;
    for (const resolve of idleWaiters.splice(0)) {
      resolve();
    }
  }

  function takeBatch(): PendingBatch {
    const inserts: PendingInsert[] = [];
    const logs: ValidatedLog[] = [];

    while (pending.length > 0) {
      const next = pending[0];
      if (next === undefined) break;
      if (inserts.length > 0 && logs.length + next.logs.length > options.maxLogsPerBatch) {
        break;
      }

      pending.shift();
      pendingLogCount -= next.logs.length;
      inserts.push(next);
      logs.push(...next.logs);
    }

    return { logs, inserts };
  }

  function scheduleFlush(): void {
    if (pending.length === 0) {
      resolveIdleWaiters();
      return;
    }

    if (pendingLogCount >= options.maxLogsPerBatch) {
      if (flushTimer !== undefined) {
        clearTimeout(flushTimer);
        flushTimer = undefined;
      }
      flushAvailableBatches();
      return;
    }

    if (flushTimer === undefined) {
      flushTimer = setTimeout(() => {
        flushTimer = undefined;
        flushAvailableBatches();
      }, options.maxWaitMs);
    }
  }

  function flushAvailableBatches(): void {
    while (activeBatches < options.concurrency && pending.length > 0) {
      const batch = takeBatch();
      activeBatches += 1;

      void repository
        .insertLogs(batch.logs)
        .then(() => {
          for (const insert of batch.inserts) {
            insert.resolve();
          }
        })
        .catch((error: unknown) => {
          for (const insert of batch.inserts) {
            insert.reject(error);
          }
        })
        .finally(() => {
          activeBatches -= 1;
          scheduleFlush();
        });
    }
  }

  return {
    insertLogs(logs: readonly ValidatedLog[]): Promise<void> {
      if (logs.length === 0) {
        return Promise.resolve();
      }

      return new Promise<void>((resolve, reject) => {
        pending.push({ logs, resolve, reject });
        pendingLogCount += logs.length;
        scheduleFlush();
      });
    },

    flush(): Promise<void> {
      if (flushTimer !== undefined) {
        clearTimeout(flushTimer);
        flushTimer = undefined;
      }
      flushAvailableBatches();

      if (isIdle()) {
        return Promise.resolve();
      }

      return new Promise<void>((resolve) => {
        idleWaiters.push(resolve);
      });
    },
  };
}
