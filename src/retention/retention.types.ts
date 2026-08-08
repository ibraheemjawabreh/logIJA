export interface RetentionConfig {
  retentionDays: number;
  intervalSeconds: number;
  batchSize: number;
  maxBatchesPerCycle: number;
}

export interface RetentionCycleResult {
  cutoff: string;
  deleted: number;
  batches: number;
  hasMore: boolean;
}

export interface RetentionRepository {
  deleteExpiredBatch: (cutoff: string, batchSize: number) => Promise<number>;
}

export interface RetentionLogger {
  info: (message: string, data?: Record<string, unknown>) => void;
  error: (message: string, data?: Record<string, unknown>) => void;
}
