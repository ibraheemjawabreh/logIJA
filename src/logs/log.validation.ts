import { LOG_LEVELS, type LogAttributes, type LogLevel, type ValidatedLog } from "./log.types.js";

export const MAX_LOGS_PER_BATCH = 5_000;

const MAX_FUTURE_MS = 5 * 60 * 1_000;
const TIMESTAMP_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/;

interface ValidationSuccess {
  ok: true;
  log: ValidatedLog;
}

interface ValidationFailure {
  ok: false;
  reason: string;
}

export type LogValidationResult = ValidationSuccess | ValidationFailure;
export type TimestampValidationResult = ValidationFailure | { ok: true; timestamp: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isLogLevel(value: string): value is LogLevel {
  return (LOG_LEVELS as readonly string[]).includes(value);
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function parseStrictTimestamp(value: unknown): TimestampValidationResult {
  if (typeof value !== "string") {
    return { ok: false, reason: "timestamp is required and must be a string" };
  }

  const match = TIMESTAMP_PATTERN.exec(value);
  if (match === null) {
    return { ok: false, reason: "invalid timestamp" };
  }

  const [, yearRaw, monthRaw, dayRaw, hourRaw, minuteRaw, secondRaw, fractionRaw, offsetRaw] =
    match;
  if (
    yearRaw === undefined ||
    monthRaw === undefined ||
    dayRaw === undefined ||
    hourRaw === undefined ||
    minuteRaw === undefined ||
    secondRaw === undefined ||
    offsetRaw === undefined
  ) {
    return { ok: false, reason: "invalid timestamp" };
  }

  const year = Number(yearRaw);
  const month = Number(monthRaw);
  const day = Number(dayRaw);
  const hour = Number(hourRaw);
  const minute = Number(minuteRaw);
  const second = Number(secondRaw);
  const fraction = fractionRaw ?? "";
  const millisecond = Number(fraction.padEnd(3, "0").slice(0, 3) || "0");

  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth(year, month) ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    return { ok: false, reason: "invalid timestamp" };
  }

  if (offsetRaw === "Z") {
    const msStr = String(millisecond).padStart(3, "0");
    return {
      ok: true,
      timestamp: `${yearRaw}-${monthRaw}-${dayRaw}T${hourRaw}:${minuteRaw}:${secondRaw}.${msStr}Z`,
    };
  }

  const sign = offsetRaw[0] === "-" ? -1 : 1;
  const offsetHour = Number(offsetRaw.slice(1, 3));
  const offsetMinute = Number(offsetRaw.slice(4, 6));
  if (offsetHour > 23 || offsetMinute > 59) {
    return { ok: false, reason: "invalid timestamp" };
  }
  const offsetMinutes = sign * (offsetHour * 60 + offsetMinute);

  const utcMillis =
    Date.UTC(year, month - 1, day, hour, minute, second, millisecond) - offsetMinutes * 60_000;
  const timestamp = new Date(utcMillis);
  if (Number.isNaN(timestamp.getTime())) {
    return { ok: false, reason: "invalid timestamp" };
  }

  return { ok: true, timestamp: timestamp.toISOString() };
}

function parseIngestionTimestamp(value: unknown, now: Date): TimestampValidationResult {
  const parsed = parseStrictTimestamp(value);
  if (!parsed.ok) return parsed;

  if (Date.parse(parsed.timestamp) - now.getTime() > MAX_FUTURE_MS) {
    return { ok: false, reason: "timestamp is more than 5 minutes in the future" };
  }

  return parsed;
}

function validateNonEmptyString(
  value: unknown,
  field: "service" | "message",
): ValidationFailure | { ok: true; value: string } {
  if (typeof value !== "string") {
    return { ok: false, reason: `${field} is required and must be a string` };
  }
  if (value.trim().length === 0) {
    return { ok: false, reason: `${field} must be non-empty` };
  }
  return { ok: true, value };
}

function validateAttributes(
  value: unknown,
):
  | ValidationFailure
  | { ok: true; attributes: LogAttributes; attributesSearch: Record<string, string> } {
  if (value === undefined) {
    return { ok: true, attributes: {}, attributesSearch: {} };
  }
  if (!isRecord(value)) {
    return { ok: false, reason: "attributes must be a flat object" };
  }

  const attributes: LogAttributes = {};
  const attributesSearch: Record<string, string> = {};

  for (const [key, attributeValue] of Object.entries(value)) {
    if (
      typeof attributeValue !== "string" &&
      typeof attributeValue !== "number" &&
      typeof attributeValue !== "boolean"
    ) {
      return { ok: false, reason: `invalid attributes.${key}: must be string, number, or boolean` };
    }
    if (typeof attributeValue === "number" && !Number.isFinite(attributeValue)) {
      return { ok: false, reason: `invalid attributes.${key}: number must be finite` };
    }
    attributes[key] = attributeValue;
    attributesSearch[key] = String(attributeValue);
  }

  return { ok: true, attributes, attributesSearch };
}

export function validateLogEntry(raw: unknown, now: Date = new Date()): LogValidationResult {
  if (!isRecord(raw)) {
    return { ok: false, reason: "log entry must be an object" };
  }

  const timestamp = parseIngestionTimestamp(raw["timestamp"], now);
  if (!timestamp.ok) return timestamp;

  const level = raw["level"];
  if (typeof level !== "string") {
    return { ok: false, reason: "level is required and must be a string" };
  }
  if (!isLogLevel(level)) {
    return { ok: false, reason: `invalid level: '${level}'` };
  }

  const service = validateNonEmptyString(raw["service"], "service");
  if (!service.ok) return service;

  const message = validateNonEmptyString(raw["message"], "message");
  if (!message.ok) return message;

  const attributes = validateAttributes(raw["attributes"]);
  if (!attributes.ok) return attributes;

  return {
    ok: true,
    log: {
      timestamp: timestamp.timestamp,
      level,
      service: service.value,
      message: message.value,
      attributes: attributes.attributes,
      attributesSearch: attributes.attributesSearch,
    },
  };
}
