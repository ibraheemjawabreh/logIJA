import type { Pool } from "pg";
import { buildAggregateLogsQuery, buildListLogsQuery } from "./log.query-builder.js";
import type {
  AggregateBucket,
  LogAttributeValue,
  LogAttributes,
  LogLevel,
  LogRepository,
  PersistedLog,
  ValidatedAggregateQuery,
  ValidatedLog,
  ValidatedLogQuery,
} from "./log.types.js";

const COLUMNS_PER_LOG = 6;

interface LogRow {
  id: string;
  timestamp: Date | string;
  level: LogLevel;
  service: string;
  message: string;
  attributes: unknown;
}

interface AggregateRow {
  start: Date | string;
  group: string | null;
  count: string;
}

function isLogAttributeValue(value: unknown): value is LogAttributeValue {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function toLogAttributes(value: unknown): LogAttributes {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }

  const attributes: LogAttributes = {};
  for (const [key, attributeValue] of Object.entries(value)) {
    if (isLogAttributeValue(attributeValue)) {
      attributes[key] = attributeValue;
    }
  }
  return attributes;
}

function toIsoTimestamp(value: Date | string): string {
  if (value instanceof Date) {
    return value.toISOString();
  }
  return new Date(value).toISOString();
}

function toSafeCount(value: string): number {
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error("aggregate count exceeds safe integer range");
  }
  return count;
}

export function createLogRepository(pool: Pool): LogRepository {
  return {
    async insertLogs(logs: readonly ValidatedLog[]): Promise<void> {
      if (logs.length === 0) {
        return;
      }

      const values: unknown[] = [];
      const rows = logs.map((log, index) => {
        const base = index * COLUMNS_PER_LOG;
        values.push(
          log.timestamp,
          log.level,
          log.service,
          log.message,
          JSON.stringify(log.attributes),
          JSON.stringify(log.attributesSearch),
        );
        return `($${base + 1}::timestamptz, $${base + 2}::text, $${base + 3}::text, $${base + 4}::text, $${base + 5}::jsonb, $${base + 6}::jsonb)`;
      });

      await pool.query(
        `
          INSERT INTO logs (
            timestamp,
            level,
            service,
            message,
            attributes,
            attributes_search
          )
          VALUES ${rows.join(", ")}
        `,
        values,
      );
    },

    async listLogs(query: ValidatedLogQuery): Promise<readonly PersistedLog[]> {
      const builtQuery = buildListLogsQuery(query);
      const result = await pool.query<LogRow>(builtQuery.text, builtQuery.values);

      return result.rows.map((row) => ({
        id: row.id,
        timestamp: toIsoTimestamp(row.timestamp),
        level: row.level,
        service: row.service,
        message: row.message,
        attributes: toLogAttributes(row.attributes),
      }));
    },

    async aggregateLogs(query: ValidatedAggregateQuery): Promise<readonly AggregateBucket[]> {
      const builtQuery = buildAggregateLogsQuery(query);
      const result = await pool.query<AggregateRow>(builtQuery.text, builtQuery.values);

      return result.rows.map((row) => ({
        start: toIsoTimestamp(row.start),
        group: row.group,
        count: toSafeCount(row.count),
      }));
    },
  };
}
