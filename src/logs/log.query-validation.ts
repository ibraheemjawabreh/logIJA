import { decodeCursor } from "./log.cursor.js";
import {
  LOG_LEVELS,
  type AggregateBucketSize,
  type AggregateGroupBy,
  type LogLevel,
} from "./log.types.js";
import { parseStrictTimestamp } from "./log.validation.js";
import type { AttributeFilter, ValidatedAggregateQuery, ValidatedLogQuery } from "./log.types.js";

export const DEFAULT_LOG_QUERY_LIMIT = 100;
export const MAX_LOG_QUERY_LIMIT = 1_000;

const AGGREGATE_BUCKETS = ["1m", "5m", "1h", "1d"] as const;
const AGGREGATE_GROUPS = ["service", "level"] as const;
const ATTRIBUTE_KEY_PATTERN = /^[A-Za-z0-9_.:-]+$/;

interface QueryValidationSuccess<T> {
  ok: true;
  value: T;
}

interface QueryValidationFailure {
  ok: false;
  error: string;
}

export type QueryValidationResult<T> = QueryValidationSuccess<T> | QueryValidationFailure;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readOptionalSingle(
  query: Record<string, unknown>,
  key: string,
): QueryValidationResult<string | undefined> {
  const value = query[key];
  if (value === undefined) {
    return { ok: true, value: undefined };
  }
  if (Array.isArray(value)) {
    return { ok: false, error: `${key} must be provided only once` };
  }
  if (typeof value !== "string") {
    return { ok: false, error: `${key} must be a string` };
  }
  return { ok: true, value };
}

function parseLevel(value: string | undefined): QueryValidationResult<LogLevel | undefined> {
  if (value === undefined) {
    return { ok: true, value: undefined };
  }
  if (!(LOG_LEVELS as readonly string[]).includes(value)) {
    return { ok: false, error: `invalid level: '${value}'` };
  }
  return { ok: true, value: value as LogLevel };
}

function parseOptionalTimestamp(
  value: string | undefined,
  field: "since" | "until",
): QueryValidationResult<string | undefined> {
  if (value === undefined) {
    return { ok: true, value: undefined };
  }
  const parsed = parseStrictTimestamp(value);
  if (!parsed.ok) {
    return { ok: false, error: `invalid ${field}` };
  }
  return { ok: true, value: parsed.timestamp };
}

function parseRequiredTimestamp(
  value: string | undefined,
  field: "since" | "until",
): QueryValidationResult<string> {
  if (value === undefined) {
    return { ok: false, error: `${field} is required` };
  }
  const parsed = parseStrictTimestamp(value);
  if (!parsed.ok) {
    return { ok: false, error: `invalid ${field}` };
  }
  return { ok: true, value: parsed.timestamp };
}

function validateTimeRange(
  since: string | undefined,
  until: string | undefined,
): QueryValidationResult<null> {
  if (
    since !== undefined &&
    until !== undefined &&
    new Date(until).getTime() <= new Date(since).getTime()
  ) {
    return { ok: false, error: "until must be strictly later than since" };
  }
  return { ok: true, value: null };
}

function parseLimit(value: string | undefined): QueryValidationResult<number> {
  if (value === undefined) {
    return { ok: true, value: DEFAULT_LOG_QUERY_LIMIT };
  }
  if (!/^\d+$/.test(value)) {
    return { ok: false, error: "limit must be an integer between 1 and 1000" };
  }
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LOG_QUERY_LIMIT) {
    return { ok: false, error: "limit must be an integer between 1 and 1000" };
  }
  return { ok: true, value: limit };
}

function parseAttributes(query: Record<string, unknown>): QueryValidationResult<AttributeFilter[]> {
  const attributes: AttributeFilter[] = [];

  for (const [key, value] of Object.entries(query)) {
    if (!key.startsWith("attr.")) {
      continue;
    }

    const attributeKey = key.slice("attr.".length);
    if (
      attributeKey.length === 0 ||
      attributeKey.length > 128 ||
      !ATTRIBUTE_KEY_PATTERN.test(attributeKey)
    ) {
      return { ok: false, error: "malformed attr key" };
    }
    if (Array.isArray(value)) {
      return { ok: false, error: `${key} must be provided only once` };
    }
    if (typeof value !== "string") {
      return { ok: false, error: `${key} must be a string` };
    }

    attributes.push({ key: attributeKey, value });
  }

  return { ok: true, value: attributes };
}

function parseBucket(value: string | undefined): QueryValidationResult<AggregateBucketSize> {
  if (value === undefined) {
    return { ok: false, error: "bucket is required" };
  }
  if (!(AGGREGATE_BUCKETS as readonly string[]).includes(value)) {
    return { ok: false, error: "invalid bucket" };
  }
  return { ok: true, value: value as AggregateBucketSize };
}

function parseGroupBy(
  value: string | undefined,
): QueryValidationResult<AggregateGroupBy | undefined> {
  if (value === undefined) {
    return { ok: true, value: undefined };
  }
  if (!(AGGREGATE_GROUPS as readonly string[]).includes(value)) {
    return { ok: false, error: "invalid group_by" };
  }
  return { ok: true, value: value as AggregateGroupBy };
}

export function parseLogQuery(
  raw: unknown,
  cursorSecret: string,
): QueryValidationResult<ValidatedLogQuery> {
  if (!isRecord(raw)) {
    return { ok: false, error: "query parameters must be an object" };
  }

  const service = readOptionalSingle(raw, "service");
  if (!service.ok) return service;
  const levelRaw = readOptionalSingle(raw, "level");
  if (!levelRaw.ok) return levelRaw;
  const level = parseLevel(levelRaw.value);
  if (!level.ok) return level;
  const sinceRaw = readOptionalSingle(raw, "since");
  if (!sinceRaw.ok) return sinceRaw;
  const since = parseOptionalTimestamp(sinceRaw.value, "since");
  if (!since.ok) return since;
  const untilRaw = readOptionalSingle(raw, "until");
  if (!untilRaw.ok) return untilRaw;
  const until = parseOptionalTimestamp(untilRaw.value, "until");
  if (!until.ok) return until;
  const range = validateTimeRange(since.value, until.value);
  if (!range.ok) return range;
  const limitRaw = readOptionalSingle(raw, "limit");
  if (!limitRaw.ok) return limitRaw;
  const limit = parseLimit(limitRaw.value);
  if (!limit.ok) return limit;
  const attributes = parseAttributes(raw);
  if (!attributes.ok) return attributes;
  const q = readOptionalSingle(raw, "q");
  if (!q.ok) return q;
  const cursorRaw = readOptionalSingle(raw, "cursor");
  if (!cursorRaw.ok) return cursorRaw;
  const cursor =
    cursorRaw.value === undefined ? undefined : decodeCursor(cursorRaw.value, cursorSecret);
  if (cursorRaw.value !== undefined && cursor === null) {
    return { ok: false, error: "malformed cursor" };
  }

  return {
    ok: true,
    value: {
      ...(service.value !== undefined ? { service: service.value } : {}),
      ...(level.value !== undefined ? { level: level.value } : {}),
      ...(since.value !== undefined ? { since: since.value } : {}),
      ...(until.value !== undefined ? { until: until.value } : {}),
      attributes: attributes.value,
      ...(q.value !== undefined && q.value.length > 0 ? { q: q.value } : {}),
      limit: limit.value,
      ...(cursor !== undefined && cursor !== null ? { cursor } : {}),
    },
  };
}

export function parseAggregateQuery(raw: unknown): QueryValidationResult<ValidatedAggregateQuery> {
  if (!isRecord(raw)) {
    return { ok: false, error: "query parameters must be an object" };
  }

  const service = readOptionalSingle(raw, "service");
  if (!service.ok) return service;
  const levelRaw = readOptionalSingle(raw, "level");
  if (!levelRaw.ok) return levelRaw;
  const level = parseLevel(levelRaw.value);
  if (!level.ok) return level;
  const sinceRaw = readOptionalSingle(raw, "since");
  if (!sinceRaw.ok) return sinceRaw;
  const since = parseRequiredTimestamp(sinceRaw.value, "since");
  if (!since.ok) return since;
  const untilRaw = readOptionalSingle(raw, "until");
  if (!untilRaw.ok) return untilRaw;
  const until = parseRequiredTimestamp(untilRaw.value, "until");
  if (!until.ok) return until;
  const range = validateTimeRange(since.value, until.value);
  if (!range.ok) return range;
  const attributes = parseAttributes(raw);
  if (!attributes.ok) return attributes;
  const q = readOptionalSingle(raw, "q");
  if (!q.ok) return q;
  const bucketRaw = readOptionalSingle(raw, "bucket");
  if (!bucketRaw.ok) return bucketRaw;
  const bucket = parseBucket(bucketRaw.value);
  if (!bucket.ok) return bucket;
  const groupByRaw = readOptionalSingle(raw, "group_by");
  if (!groupByRaw.ok) return groupByRaw;
  const groupBy = parseGroupBy(groupByRaw.value);
  if (!groupBy.ok) return groupBy;

  return {
    ok: true,
    value: {
      ...(service.value !== undefined ? { service: service.value } : {}),
      ...(level.value !== undefined ? { level: level.value } : {}),
      since: since.value,
      until: until.value,
      attributes: attributes.value,
      ...(q.value !== undefined && q.value.length > 0 ? { q: q.value } : {}),
      bucket: bucket.value,
      ...(groupBy.value !== undefined ? { groupBy: groupBy.value } : {}),
    },
  };
}
