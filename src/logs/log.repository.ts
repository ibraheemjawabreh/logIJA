import type { Pool, PoolClient } from "pg";
import type { IngestStrategy } from "../config.js";
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

interface InsertQuery {
  text: string;
  values: unknown[];
}

interface MinuteAggregate {
  minute: string;
  service: string;
  level: LogLevel;
  count: number;
}

const INSERT_COLUMNS = "(timestamp, level, service, message, attributes, attributes_search)";
const UNNEST_INSERT_SQL = `
  INSERT INTO logs ${INSERT_COLUMNS}
  SELECT *
  FROM unnest(
    $1::timestamptz[],
    $2::text[],
    $3::text[],
    $4::text[],
    $5::jsonb[],
    $6::jsonb[]
  )
`;
const UPSERT_MINUTE_AGGREGATES_SQL = `
  INSERT INTO log_minute_aggregates (minute, service, level, count)
  SELECT *
  FROM unnest(
    $1::timestamptz[],
    $2::text[],
    $3::text[],
    $4::bigint[]
  )
  ON CONFLICT (minute, service, level) DO UPDATE
  SET count = log_minute_aggregates.count + EXCLUDED.count
`;

function stringifyAttributes(log: ValidatedLog): readonly [string, string] {
  return [JSON.stringify(log.attributes), JSON.stringify(log.attributesSearch)];
}

function buildMultirowInsert(logs: readonly ValidatedLog[]): InsertQuery {
  const values: unknown[] = [];
  const rows = logs.map((log, index) => {
    const offset = index * 6;
    const [attributes, attributesSearch] = stringifyAttributes(log);
    values.push(log.timestamp, log.level, log.service, log.message, attributes, attributesSearch);
    return `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}::jsonb, $${offset + 6}::jsonb)`;
  });

  return {
    text: `INSERT INTO logs ${INSERT_COLUMNS} VALUES ${rows.join(", ")}`,
    values,
  };
}

function buildUnnestInsert(logs: readonly ValidatedLog[]): InsertQuery {
  const timestamps: string[] = [];
  const levels: string[] = [];
  const services: string[] = [];
  const messages: string[] = [];
  const attributes: string[] = [];
  const attributesSearch: string[] = [];

  for (const log of logs) {
    const [serializedAttributes, serializedAttributesSearch] = stringifyAttributes(log);
    timestamps.push(log.timestamp);
    levels.push(log.level);
    services.push(log.service);
    messages.push(log.message);
    attributes.push(serializedAttributes);
    attributesSearch.push(serializedAttributesSearch);
  }

  return {
    text: UNNEST_INSERT_SQL,
    values: [timestamps, levels, services, messages, attributes, attributesSearch],
  };
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

export function createLogRepository(
  pool: Pool,
  ingestStrategy: IngestStrategy = "unnest",
): LogRepository {
  return {
    async insertLogs(logs: readonly ValidatedLog[]): Promise<void> {
      if (logs.length === 0) {
        return;
      }

      const query =
        ingestStrategy === "multirow" ? buildMultirowInsert(logs) : buildUnnestInsert(logs);
      const client = await pool.connect();
      try {
        await client.query(query.text, query.values);
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
