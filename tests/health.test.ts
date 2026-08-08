import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";

// Use silent log level so Vitest output is not polluted by Fastify logs
const config = loadConfig({ LOG_LEVEL: "silent" });

describe("GET /health — database available", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await buildApp(config, { checkDb: async () => true });
  });

  afterEach(async () => {
    await app.close();
  });

  it("returns HTTP 200", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
  });

  it("returns exactly { status: 'ok' }", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.json<{ status: string }>()).toEqual({ status: "ok" });
  });
});

describe("GET /health — database unavailable", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await buildApp(config, { checkDb: async () => false });
  });

  afterEach(async () => {
    await app.close();
  });

  it("returns HTTP 503", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(503);
  });

  it("returns exactly { status: 'unavailable' }", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.json<{ status: string }>()).toEqual({ status: "unavailable" });
  });
});

describe("GET /health — checkDb throws", () => {
  it("returns HTTP 503 when checkDb rejects", async () => {
    const app = await buildApp(config, {
      checkDb: async () => {
        throw new Error("connection refused");
      },
    });
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(503);
    await app.close();
  });
});
