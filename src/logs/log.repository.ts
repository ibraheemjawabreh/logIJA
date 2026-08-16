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

const UNNEST_COMBINED_INSERT_SQL = `
  WITH inserted_logs AS (
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
  )
  INSERT INTO log_minute_aggregates (minute, service, level, count)
  SELECT *
  FROM unnest(
    $7::timestamptz[],
    $8::text[],
    $9::text[],
    $10::bigint[]
  )
  ON CONFLICT (minute, service, level)
  DO UPDATE SET count = log_minute_aggregates.count + EXCLUDED.count;
`;

function buildUnnestInsert(logs: readonly ValidatedLog[]): InsertQuery {
  const len = logs.length;
  const timestamps = new Array<string>(len);
  const levels = new Array<string>(len);
  const services = new Array<string>(len);
  const messages = new Array<string>(len);
  const attributes = new Array<string>(len);
  const attributesSearch = new Array<string>(len);

  for (let i = 0; i < len; i++) {
    const log = logs[i]!;
    const hasAttrs = Object.keys(log.attributes).length > 0;
    timestamps[i] = log.timestamp;
    levels[i] = log.level;
    services[i] = log.service;
    messages[i] = log.message;
    attributes[i] = hasAttrs ? JSON.stringify(log.attributes) : EMPTY_JSON;
    attributesSearch[i] = hasAttrs ? JSON.stringify(log.attributesSearch) : EMPTY_JSON;
  }

  return {
    text: UNNEST_INSERT_SQL,
    values: [timestamps, levels, services, messages, attributes, attributesSearch],
  };
}

function buildMinuteAggregates(logs: readonly ValidatedLog[]) {
  const map = new Map<string, { minute: string; service: string; level: string; count: number }>();
  const len = logs.length;
  for (let i = 0; i < len; i++) {
    const log = logs[i]!;
    const minute = log.timestamp.slice(0, 16) + ":00.000Z";
    const key = `${minute}|${log.service}|${log.level}`;
    const existing = map.get(key);
    if (existing !== undefined) {
      existing.count += 1;
    } else {
      map.set(key, { minute, service: log.service, level: log.level, count: 1 });
    }
  }

  const mapSize = map.size;
  const minutes = new Array<string>(mapSize);
  const services = new Array<string>(mapSize);
  const levels = new Array<string>(mapSize);
  const counts = new Array<number>(mapSize);

  let idx = 0;
  for (const entry of map.values()) {
    minutes[idx] = entry.minute;
    services[idx] = entry.service;
    levels[idx] = entry.level;
    counts[idx] = entry.count;
    idx += 1;
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

      if (ingestStrategy === "unnest") {
        const unnestData = buildUnnestInsert(logs);
        const minuteAggs = buildMinuteAggregates(logs);

        if (minuteAggs.minutes.length > 0) {
          await pool.query(UNNEST_COMBINED_INSERT_SQL, [
            ...unnestData.values,
            minuteAggs.minutes,
            minuteAggs.services,
            minuteAggs.levels,
            minuteAggs.counts,
          ]);
        } else {
          await pool.query(unnestData.text, unnestData.values);
        }
        return;
      }

      const multirowQuery = buildMultirowInsert(logs);
      const minuteAggs = buildMinuteAggregates(logs);

      const client = await pool.connect();
      try {
        await client.query(multirowQuery.text, multirowQuery.values);
        if (minuteAggs.minutes.length > 0) {
          await client.query(
            `
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
          `,
            [minuteAggs.minutes, minuteAggs.services, minuteAggs.levels, minuteAggs.counts],
          );
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
