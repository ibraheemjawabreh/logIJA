import { validateLogEntry } from "./log.validation.js";
import { encodeCursor } from "./log.cursor.js";
import { createIngestionBatcher } from "./log.ingestion-batcher.js";
import type {
  AggregateResponse,
  IngestionResult,
  LogListResponse,
  LogRepository,
  RejectedLogEntry,
  ValidatedAggregateQuery,
  ValidatedLog,
  ValidatedLogQuery,
} from "./log.types.js";

export interface LogIngestionService {
  ingestLogs: (rawLogs: readonly unknown[]) => Promise<IngestionResult>;
  queryLogs: (query: ValidatedLogQuery) => Promise<LogListResponse>;
  aggregateLogs: (query: ValidatedAggregateQuery) => Promise<AggregateResponse>;
  flush: () => Promise<void>;
}

export interface LogIngestionServiceOptions {
  now?: () => Date;
  cursorSecret: string;
  ingestionBatchMaxLogs?: number;
  ingestionBatchWaitMs?: number;
  ingestionBatchConcurrency?: number;
}

export function createLogIngestionService(
  repository: LogRepository,
  options: LogIngestionServiceOptions,
): LogIngestionService {
  const now = options.now ?? (() => new Date());
  const ingestionBatcher = createIngestionBatcher(repository, {
    maxLogsPerBatch: options.ingestionBatchMaxLogs ?? 1_000,
    maxWaitMs: options.ingestionBatchWaitMs ?? 75,
    concurrency: options.ingestionBatchConcurrency ?? 2,
  });

  return {
    async ingestLogs(rawLogs: readonly unknown[]): Promise<IngestionResult> {
      const acceptedLogs: ValidatedLog[] = [];
      const rejected: RejectedLogEntry[] = [];
      const requestNow = now();

      rawLogs.forEach((rawLog, index) => {
        const validation = validateLogEntry(rawLog, requestNow);
        if (validation.ok) {
          acceptedLogs.push(validation.log);
          return;
        }
        rejected.push({ index, reason: validation.reason });
      });

      if (acceptedLogs.length > 0) {
        await ingestionBatcher.insertLogs(acceptedLogs);
      }

      return {
        accepted: acceptedLogs.length,
        rejected,
      };
    },

    async queryLogs(query: ValidatedLogQuery): Promise<LogListResponse> {
      const rows = await repository.listLogs(query);
      const logs = rows.slice(0, query.limit);
      const lastLog = logs.at(-1);

      return {
        logs,
        next_cursor:
          rows.length > query.limit && lastLog !== undefined
            ? encodeCursor({ timestamp: lastLog.timestamp, id: lastLog.id }, options.cursorSecret)
            : null,
      };
    },

    async aggregateLogs(query: ValidatedAggregateQuery): Promise<AggregateResponse> {
      const buckets = await repository.aggregateLogs(query);
      return { buckets: [...buckets] };
    },

    flush: () => ingestionBatcher.flush(),
  };
}
