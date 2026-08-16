import type { Pool } from "pg";
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

const INSERT_COLUMNS = "(timestamp, level, service, message, attributes, attributes_search)";
const EMPTY_JSON = "{}";

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

function stringifyAttributes(log: ValidatedLog): readonly [string, string] {
  const hasAttrs = Object.keys(log.attributes).length > 0;
  return [
    hasAttrs ? JSON.stringify(log.attributes) : EMPTY_JSON,
    hasAttrs ? JSON.stringify(log.attributesSearch) : EMPTY_JSON,
  ];
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
const UPSERT_MINUTE_AGGREGATES_SQL = `
  INSERT INTO log_minute_aggregates (minute, service, level, count)
  SELECT *
  FROM unnest(
    $1::timestamptz[],
    $2::text[],
    $3::text[],
    $4::bigint[]
  )
  ON CONFLICT (minute, service, level)
  DO UPDATE SET count = log_minute_aggregates.count + EXCLUDED.count;
`;

function buildMinuteAggregates(logs: readonly ValidatedLog[]) {
  const map = new Map<string, { minute: string; service: string; level: string; count: number }>();
  for (let i = 0; i < logs.length; i++) {
    const log = logs[i];
    if (log === undefined) continue;
    const minute = log.timestamp.slice(0, 16) + ":00.000Z";
    const key = `${minute}|${log.service}|${log.level}`;
    const existing = map.get(key);
    if (existing !== undefined) {
      existing.count += 1;
    } else {
      map.set(key, { minute, service: log.service, level: log.level, count: 1 });
    }
  }

  const minutes: string[] = [];
  const services: string[] = [];
  const levels: string[] = [];
  const counts: number[] = [];

  for (const entry of map.values()) {
    minutes.push(entry.minute);
    services.push(entry.service);
    levels.push(entry.level);
    counts.push(entry.count);
  }

  return { minutes, services, levels, counts };
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
  if (typeof value === "string") {
    if (value.endsWith("Z") && value.length === 24) {
      return value;
    }
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? value : d.toISOString();
  }
  return value.toISOString();
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
      const minuteAggs = buildMinuteAggregates(logs);

      const client = await pool.connect();
      try {
        await client.query(query.text, query.values);
        if (minuteAggs.minutes.length > 0) {
          await client.query(UPSERT_MINUTE_AGGREGATES_SQL, [
            minuteAggs.minutes,
            minuteAggs.services,
            minuteAggs.levels,
            minuteAggs.counts,
          ]);
        }
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
