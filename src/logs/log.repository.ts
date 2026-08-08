import type { Pool } from "pg";
import { from as copyFrom } from "pg-copy-streams";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
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

      const client = await pool.connect();
      try {
        const stream = client.query(
          copyFrom(
            "COPY logs (timestamp, level, service, message, attributes, attributes_search) FROM STDIN WITH (FORMAT csv)",
          ),
        );

        const rowIterator = function* () {
          for (let i = 0; i < logs.length; i++) {
            const log = logs[i];
            if (!log) continue;

            const t = log.timestamp;
            const l = log.level;

            // In CSV format, quotes must be escaped by doubling them.
            // Wrapping the entire field in quotes handles any internal delimiters, newlines, or quotes safely.
            const escapeCsv = (str: string) => `"${str.replaceAll('"', '""')}"`;

            const s = escapeCsv(log.service);
            const m = escapeCsv(log.message);
            const a = escapeCsv(JSON.stringify(log.attributes));
            const search = escapeCsv(JSON.stringify(log.attributesSearch));

            yield `${t},${l},${s},${m},${a},${search}\n`;
          }
        }();

        await pipeline(Readable.from(rowIterator), stream);
      } finally {
        client.release();
      }
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
