export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

export type LogAttributeValue = string | number | boolean;
export type LogAttributes = Record<string, LogAttributeValue>;

export interface ValidatedLog {
  timestamp: string;
  level: LogLevel;
  service: string;
  message: string;
  attributes: LogAttributes;
  attributesSearch: Record<string, string>;
}

export interface RejectedLogEntry {
  index: number;
  reason: string;
}

export interface IngestionResult {
  accepted: number;
  rejected: RejectedLogEntry[];
}

export interface LogRepository {
  insertLogs: (logs: readonly ValidatedLog[]) => Promise<void>;
  listLogs: (query: ValidatedLogQuery) => Promise<readonly PersistedLog[]>;
  aggregateLogs: (query: ValidatedAggregateQuery) => Promise<readonly AggregateBucket[]>;
}

export interface PersistedLog {
  id: string;
  timestamp: string;
  level: LogLevel;
  service: string;
  message: string;
  attributes: LogAttributes;
}

export interface LogListResponse {
  logs: PersistedLog[];
  next_cursor: string | null;
}

export interface QueryCursor {
  timestamp: string;
  id: string;
}

export interface AttributeFilter {
  key: string;
  value: string;
}

export interface ValidatedLogQuery {
  service?: string;
  level?: LogLevel;
  since?: string;
  until?: string;
  attributes: AttributeFilter[];
  q?: string;
  limit: number;
  cursor?: QueryCursor;
}

export type AggregateBucketSize = "1m" | "5m" | "1h" | "1d";
export type AggregateGroupBy = "service" | "level";

export interface ValidatedAggregateQuery {
  service?: string;
  level?: LogLevel;
  since: string;
  until: string;
  attributes: AttributeFilter[];
  q?: string;
  bucket: AggregateBucketSize;
  groupBy?: AggregateGroupBy;
}

export interface AggregateBucket {
  start: string;
  group: string | null;
  count: number;
}

export interface AggregateResponse {
  buckets: AggregateBucket[];
}
