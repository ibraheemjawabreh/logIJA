import type {
  RetentionConfig,
  RetentionCycleResult,
  RetentionRepository,
} from "./retention.types.js";

export interface RetentionServiceOptions extends RetentionConfig {
  now?: () => Date;
}

export interface RetentionService {
  cleanupExpiredLogs: () => Promise<RetentionCycleResult>;
}

function cutoffFor(now: Date, retentionDays: number): string {
  return new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1_000).toISOString();
}

export function createRetentionService(
  repository: RetentionRepository,
  options: RetentionServiceOptions,
): RetentionService {
  const now = options.now ?? (() => new Date());

  return {
    async cleanupExpiredLogs(): Promise<RetentionCycleResult> {
      const cutoff = cutoffFor(now(), options.retentionDays);
      let deleted = 0;
      let batches = 0;
      let hasMore = false;

      for (let i = 0; i < options.maxBatchesPerCycle; i += 1) {
        const batchDeleted = await repository.deleteExpiredBatch(cutoff, options.batchSize);
        if (batchDeleted === 0) {
          hasMore = false;
          break;
        }

        deleted += batchDeleted;
        batches += 1;
        hasMore = batchDeleted === options.batchSize;

        if (batchDeleted < options.batchSize) {
          hasMore = false;
          break;
        }
      }

      return { cutoff, deleted, batches, hasMore };
    },
  };
}
