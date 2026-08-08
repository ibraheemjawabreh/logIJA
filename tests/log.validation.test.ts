import { describe, expect, it } from "vitest";
import { validateLogEntry } from "../src/logs/log.validation.js";

const now = new Date("2026-07-20T14:32:00.000Z");

function validLog(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    timestamp: "2026-07-20T14:32:01.123Z",
    level: "error",
    service: "checkout",
    message: "payment declined",
    attributes: {
      user_id: "42",
      attempts: 3,
      success: false,
    },
    ...overrides,
  };
}

describe("validateLogEntry", () => {
  it("accepts a valid log with all fields", () => {
    const result = validateLogEntry(validLog(), now);

    expect(result).toEqual({
      ok: true,
      log: {
        timestamp: "2026-07-20T14:32:01.123Z",
        level: "error",
        service: "checkout",
        message: "payment declined",
        attributes: {
          user_id: "42",
          attempts: 3,
          success: false,
        },
        attributesSearch: {
          user_id: "42",
          attempts: "3",
          success: "false",
        },
      },
    });
  });

  it("treats omitted attributes as empty objects", () => {
    const raw = validLog();
    delete raw["attributes"];

    const result = validateLogEntry(raw, now);

    expect(result).toMatchObject({
      ok: true,
      log: {
        attributes: {},
        attributesSearch: {},
      },
    });
  });

  it("accepts all supported levels", () => {
    for (const level of ["debug", "info", "warn", "error"]) {
      expect(validateLogEntry(validLog({ level }), now)).toMatchObject({ ok: true });
    }
  });

  it("rejects unsupported levels", () => {
    expect(validateLogEntry(validLog({ level: "critical" }), now)).toEqual({
      ok: false,
      reason: "invalid level: 'critical'",
    });
  });

  it("accepts a strict timestamp with an explicit offset and normalizes to UTC", () => {
    expect(
      validateLogEntry(validLog({ timestamp: "2026-07-20T16:32:01+02:00" }), now),
    ).toMatchObject({
      ok: true,
      log: { timestamp: "2026-07-20T14:32:01.000Z" },
    });
  });

  it("rejects malformed timestamps", () => {
    for (const timestamp of ["2026-07-20 14:32:01", "not-a-date", "2026-02-30T00:00:00Z"]) {
      expect(validateLogEntry(validLog({ timestamp }), now)).toEqual({
        ok: false,
        reason: "invalid timestamp",
      });
    }
  });

  it("rejects timestamps more than 5 minutes in the future", () => {
    expect(validateLogEntry(validLog({ timestamp: "2026-07-20T14:37:00.001Z" }), now)).toEqual({
      ok: false,
      reason: "timestamp is more than 5 minutes in the future",
    });
  });

  it("accepts timestamps within the permitted future tolerance", () => {
    expect(
      validateLogEntry(validLog({ timestamp: "2026-07-20T14:37:00.000Z" }), now),
    ).toMatchObject({
      ok: true,
    });
  });

  it("rejects missing, empty, whitespace-only, and non-string service values", () => {
    const missing = validLog();
    delete missing["service"];

    expect(validateLogEntry(missing, now)).toEqual({
      ok: false,
      reason: "service is required and must be a string",
    });
    expect(validateLogEntry(validLog({ service: "" }), now)).toEqual({
      ok: false,
      reason: "service must be non-empty",
    });
    expect(validateLogEntry(validLog({ service: "   " }), now)).toEqual({
      ok: false,
      reason: "service must be non-empty",
    });
    expect(validateLogEntry(validLog({ service: 42 }), now)).toEqual({
      ok: false,
      reason: "service is required and must be a string",
    });
  });

  it("rejects missing, empty, whitespace-only, and non-string message values", () => {
    const missing = validLog();
    delete missing["message"];

    expect(validateLogEntry(missing, now)).toEqual({
      ok: false,
      reason: "message is required and must be a string",
    });
    expect(validateLogEntry(validLog({ message: "" }), now)).toEqual({
      ok: false,
      reason: "message must be non-empty",
    });
    expect(validateLogEntry(validLog({ message: "   " }), now)).toEqual({
      ok: false,
      reason: "message must be non-empty",
    });
    expect(validateLogEntry(validLog({ message: false }), now)).toEqual({
      ok: false,
      reason: "message is required and must be a string",
    });
  });

  it("rejects invalid attribute values", () => {
    expect(validateLogEntry(validLog({ attributes: { user: { id: "42" } } }), now)).toEqual({
      ok: false,
      reason: "invalid attributes.user: must be string, number, or boolean",
    });
    expect(validateLogEntry(validLog({ attributes: { roles: ["admin"] } }), now)).toEqual({
      ok: false,
      reason: "invalid attributes.roles: must be string, number, or boolean",
    });
    expect(validateLogEntry(validLog({ attributes: { value: null } }), now)).toEqual({
      ok: false,
      reason: "invalid attributes.value: must be string, number, or boolean",
    });
    expect(validateLogEntry(validLog({ attributes: { nested: [["admin"]] } }), now)).toEqual({
      ok: false,
      reason: "invalid attributes.nested: must be string, number, or boolean",
    });
  });

  it("rejects non-object attributes", () => {
    expect(validateLogEntry(validLog({ attributes: [] }), now)).toEqual({
      ok: false,
      reason: "attributes must be a flat object",
    });
  });
});
