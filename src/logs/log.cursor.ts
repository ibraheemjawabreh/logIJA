import { createHmac, timingSafeEqual } from "node:crypto";
import { parseStrictTimestamp } from "./log.validation.js";
import type { QueryCursor } from "./log.types.js";

interface CursorPayload {
  v: 1;
  timestamp: string;
  id: string;
}

function encodeBase64Url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function decodeBase64Url(value: string): string {
  return Buffer.from(value, "base64url").toString("utf8");
}

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

function isCursorPayload(value: unknown): value is CursorPayload {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    record["v"] === 1 && typeof record["timestamp"] === "string" && typeof record["id"] === "string"
  );
}

export function encodeCursor(cursor: QueryCursor, secret: string): string {
  const payload: CursorPayload = { v: 1, timestamp: cursor.timestamp, id: cursor.id };
  const encodedPayload = encodeBase64Url(JSON.stringify(payload));
  return `${encodedPayload}.${sign(encodedPayload, secret)}`;
}

export function decodeCursor(raw: string, secret: string): QueryCursor | null {
  const parts = raw.split(".");
  if (parts.length !== 2) {
    return null;
  }

  const [encodedPayload, signature] = parts;
  if (encodedPayload === undefined || signature === undefined || encodedPayload.length === 0) {
    return null;
  }

  const expectedSignature = sign(encodedPayload, secret);
  const actual = Buffer.from(signature, "base64url");
  const expected = Buffer.from(expectedSignature, "base64url");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(decodeBase64Url(encodedPayload));
    if (!isCursorPayload(parsed)) {
      return null;
    }
    const timestamp = parseStrictTimestamp(parsed.timestamp);
    if (!timestamp.ok || !/^\d+$/.test(parsed.id)) {
      return null;
    }
    return { timestamp: timestamp.timestamp, id: parsed.id };
  } catch {
    return null;
  }
}
