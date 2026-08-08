import { describe, it, expect } from "vitest";
import { loadConfig } from "../src/config.js";

describe("loadConfig — defaults", () => {
  it("returns development defaults when env is empty", () => {
    const cfg = loadConfig({});
    expect(cfg.NODE_ENV).toBe("development");
    expect(cfg.HOST).toBe("0.0.0.0");
    expect(cfg.PORT).toBe(8080);
    expect(cfg.LOG_LEVEL).toBe("info");
    expect(cfg.DATABASE_URL).toBe("postgresql://logija:logija@localhost:5432/logija");
    expect(cfg.CURSOR_SECRET).toBe("logija-local-cursor-secret");
    expect(cfg.DB_POOL_MAX).toBe(10);
    expect(cfg.RETENTION_DAYS).toBe(30);
    expect(cfg.RETENTION_INTERVAL_SECONDS).toBe(60);
    expect(cfg.RETENTION_BATCH_SIZE).toBe(10000);
    expect(cfg.RETENTION_MAX_BATCHES_PER_CYCLE).toBe(10);
  });
});

describe("loadConfig — PORT", () => {
  it("accepts a valid custom port", () => {
    expect(loadConfig({ PORT: "3000" }).PORT).toBe(3000);
  });

  it("accepts the boundary value 1", () => {
    expect(loadConfig({ PORT: "1" }).PORT).toBe(1);
  });

  it("accepts the boundary value 65535", () => {
    expect(loadConfig({ PORT: "65535" }).PORT).toBe(65535);
  });

  it("throws on a non-numeric port", () => {
    expect(() => loadConfig({ PORT: "abc" })).toThrow(/PORT/);
  });

  it("throws on port 0 (out of range)", () => {
    expect(() => loadConfig({ PORT: "0" })).toThrow(/PORT/);
  });

  it("throws on port 65536 (out of range)", () => {
    expect(() => loadConfig({ PORT: "65536" })).toThrow(/PORT/);
  });

  it("throws on a decimal port value", () => {
    expect(() => loadConfig({ PORT: "80.5" })).toThrow(/PORT/);
  });
});

describe("loadConfig — NODE_ENV", () => {
  it("accepts all valid values", () => {
    expect(loadConfig({ NODE_ENV: "development" }).NODE_ENV).toBe("development");
    expect(loadConfig({ NODE_ENV: "test" }).NODE_ENV).toBe("test");
    expect(loadConfig({ NODE_ENV: "production" }).NODE_ENV).toBe("production");
  });

  it("throws on an invalid NODE_ENV", () => {
    expect(() => loadConfig({ NODE_ENV: "staging" })).toThrow(/NODE_ENV/);
  });
});

describe("loadConfig — LOG_LEVEL", () => {
  it("accepts all valid Pino levels", () => {
    for (const level of ["trace", "debug", "info", "warn", "error", "fatal", "silent"]) {
      expect(loadConfig({ LOG_LEVEL: level }).LOG_LEVEL).toBe(level);
    }
  });

  it("throws on an invalid LOG_LEVEL", () => {
    expect(() => loadConfig({ LOG_LEVEL: "verbose" })).toThrow(/LOG_LEVEL/);
  });
});

describe("loadConfig — DATABASE_URL", () => {
  it("accepts a postgresql:// URL", () => {
    const url = "postgresql://user:pass@host:5432/db";
    expect(loadConfig({ DATABASE_URL: url }).DATABASE_URL).toBe(url);
  });

  it("accepts a postgres:// URL", () => {
    const url = "postgres://user:pass@host:5432/db";
    expect(loadConfig({ DATABASE_URL: url }).DATABASE_URL).toBe(url);
  });

  it("throws on an empty DATABASE_URL", () => {
    expect(() => loadConfig({ DATABASE_URL: "" })).toThrow(/DATABASE_URL/);
  });

  it("throws on a non-postgres protocol", () => {
    expect(() => loadConfig({ DATABASE_URL: "mysql://user:pass@host/db" })).toThrow(/DATABASE_URL/);
  });
});

describe("loadConfig - CURSOR_SECRET", () => {
  it("accepts a custom cursor secret", () => {
    expect(loadConfig({ CURSOR_SECRET: "custom-secret" }).CURSOR_SECRET).toBe("custom-secret");
  });

  it("throws on an empty CURSOR_SECRET", () => {
    expect(() => loadConfig({ CURSOR_SECRET: "" })).toThrow(/CURSOR_SECRET/);
  });
});

describe("loadConfig - retention and pool settings", () => {
  it("accepts valid custom numeric settings", () => {
    const cfg = loadConfig({
      DB_POOL_MAX: "6",
      RETENTION_DAYS: "14",
      RETENTION_INTERVAL_SECONDS: "30",
      RETENTION_BATCH_SIZE: "500",
      RETENTION_MAX_BATCHES_PER_CYCLE: "3",
    });

    expect(cfg.DB_POOL_MAX).toBe(6);
    expect(cfg.RETENTION_DAYS).toBe(14);
    expect(cfg.RETENTION_INTERVAL_SECONDS).toBe(30);
    expect(cfg.RETENTION_BATCH_SIZE).toBe(500);
    expect(cfg.RETENTION_MAX_BATCHES_PER_CYCLE).toBe(3);
  });

  it.each([
    ["DB_POOL_MAX", "0"],
    ["RETENTION_DAYS", "0"],
    ["RETENTION_INTERVAL_SECONDS", "0"],
    ["RETENTION_BATCH_SIZE", "0"],
    ["RETENTION_MAX_BATCHES_PER_CYCLE", "0"],
    ["RETENTION_DAYS", "1.5"],
    ["RETENTION_BATCH_SIZE", "abc"],
  ])("rejects invalid %s", (key, value) => {
    expect(() => loadConfig({ [key]: value })).toThrow(new RegExp(key));
  });
});
