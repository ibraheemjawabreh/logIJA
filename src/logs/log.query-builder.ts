import type {
  AggregateBucketSize,
  AggregateGroupBy,
  ValidatedAggregateQuery,
  ValidatedLogQuery,
} from "./log.types.js";

export interface BuiltQuery {
  text: string;
  values: unknown[];
}

interface WhereBuildResult {
  clauses: string[];
  values: unknown[];
}

const BUCKET_INTERVALS: Record<AggregateBucketSize, string> = {
  "1m": "1 minute",
  "5m": "5 minutes",
  "1h": "1 hour",
  "1d": "1 day",
};

const GROUP_EXPRESSIONS: Record<AggregateGroupBy, string> = {
  service: "service",
  level: "level",
};

function nextParam(values: unknown[], value: unknown): string {
  values.push(value);
  return `$${values.length}`;
}

export function escapeLikeLiteral(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

function buildWhere(
  query: ValidatedLogQuery | ValidatedAggregateQuery,
  includeCursor: boolean,
  timestampColumn = "timestamp",
): WhereBuildResult {
  const clauses: string[] = [];
  const values: unknown[] = [];

  if (query.service !== undefined) {
    clauses.push(`service = ${nextParam(values, query.service)}`);
  }
  if (query.level !== undefined) {
    clauses.push(`level = ${nextParam(values, query.level)}`);
  }
  if (query.since !== undefined) {
    clauses.push(`${timestampColumn} >= ${nextParam(values, query.since)}::timestamptz`);
  }
  if (query.until !== undefined) {
    clauses.push(`${timestampColumn} < ${nextParam(values, query.until)}::timestamptz`);
  }
  if (query.attributes.length > 0) {
    const jsonbArgs: string[] = [];
    for (const attribute of query.attributes) {
      const k = nextParam(values, attribute.key);
      const v = nextParam(values, attribute.value);
      jsonbArgs.push(`${k}::text`, `${v}::text`);
    }
    clauses.push(`attributes_search @> jsonb_build_object(${jsonbArgs.join(", ")})`);
  }
  if (query.q !== undefined) {
    clauses.push(
      `message ILIKE ${nextParam(values, `%${escapeLikeLiteral(query.q)}%`)} ESCAPE E'\\\\'`,
    );
  }
  if (includeCursor && "cursor" in query && query.cursor !== undefined) {
    const timestampParam = nextParam(values, query.cursor.timestamp);
    const idParam = nextParam(values, query.cursor.id);
    clauses.push(
      `(logs.timestamp, logs.id) < (${timestampParam}::timestamptz, ${idParam}::bigint)`,
    );
  }

  return { clauses, values };
}

function whereSql(clauses: readonly string[]): string {
  return clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
}

export function buildListLogsQuery(query: ValidatedLogQuery): BuiltQuery {
  const where = buildWhere(query, true);
  const limitParam = nextParam(where.values, query.limit + 1);

  return {
    text: `
      SELECT
        id::text AS id,
        timestamp,
        level,
        service,
        message,
        COALESCE(attributes, '{}'::jsonb) AS attributes
      FROM logs
      ${whereSql(where.clauses)}
      ORDER BY logs.timestamp DESC, logs.id DESC
      LIMIT ${limitParam}
    `,
    values: where.values,
  };
}

export function buildAggregateLogsQuery(query: ValidatedAggregateQuery): BuiltQuery {
  const interval = BUCKET_INTERVALS[query.bucket];
  const groupExpression =
    query.groupBy === undefined ? "NULL::text" : GROUP_EXPRESSIONS[query.groupBy];

  // If no attributes or free-text query are present, serve from the pre-aggregated minute table
  if (query.attributes.length === 0 && query.q === undefined) {
    const where = buildWhere(query, false, "minute");
    const bucketExpression = `date_bin('${interval}'::interval, minute, '1970-01-01 00:00:00+00'::timestamptz)`;

    return {
      text: `
        SELECT
          ${bucketExpression} AS start,
          ${groupExpression} AS "group",
          SUM(count)::text AS count
        FROM log_minute_aggregates
        ${whereSql(where.clauses)}
        GROUP BY start, "group"
        ORDER BY start ASC, "group" ASC NULLS FIRST
      `,
      values: where.values,
    };
  }

  const where = buildWhere(query, false, "logs.timestamp");
  const bucketExpression = `date_bin('${interval}'::interval, logs.timestamp, '1970-01-01 00:00:00+00'::timestamptz)`;

  return {
    text: `
      SELECT
        ${bucketExpression} AS start,
        ${groupExpression} AS "group",
        COUNT(*)::text AS count
      FROM logs
      ${whereSql(where.clauses)}
      GROUP BY start, "group"
      ORDER BY start ASC, "group" ASC NULLS FIRST
    `,
    values: where.values,
  };
}

