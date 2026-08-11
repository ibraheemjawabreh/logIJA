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
  for (const attribute of query.attributes) {
    const keyParam = nextParam(values, attribute.key);
    const valueParam = nextParam(values, attribute.value);
    clauses.push(`(attributes_search ->> ${keyParam}) = ${valueParam}`);
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
      `(timestamp < ${timestampParam}::timestamptz OR (timestamp = ${timestampParam}::timestamptz AND id < ${idParam}::bigint))`,
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
      ORDER BY timestamp DESC, id DESC
      LIMIT ${limitParam}
    `,
    values: where.values,
  };
}

export function buildAggregateLogsQuery(query: ValidatedAggregateQuery): BuiltQuery {
  const interval = BUCKET_INTERVALS[query.bucket];
  const groupExpression =
    query.groupBy === undefined ? "NULL::text" : GROUP_EXPRESSIONS[query.groupBy];
  const useMinuteAggregates = query.attributes.length === 0 && query.q === undefined;
  const timestampColumn = useMinuteAggregates ? "minute" : "timestamp";
  const where = buildWhere(query, false, timestampColumn);
  const bucketExpression = `date_bin('${interval}'::interval, ${timestampColumn}, '1970-01-01 00:00:00+00'::timestamptz)`;
  const source = useMinuteAggregates ? "log_minute_aggregates" : "logs";
  const countExpression = useMinuteAggregates ? "SUM(count)::text" : "COUNT(*)::text";

  return {
    text: `
      SELECT
        ${bucketExpression} AS start,
        ${groupExpression} AS "group",
        ${countExpression} AS count
      FROM ${source}
      ${whereSql(where.clauses)}
      GROUP BY start, "group"
      ORDER BY start ASC, "group" ASC NULLS FIRST
    `,
    values: where.values,
  };
}
