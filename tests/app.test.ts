import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";

const config = loadConfig({ LOG_LEVEL: "silent" });
const checkDb = async (): Promise<boolean> => true;

describe("Application — general behaviour", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await buildApp(config, { checkDb });
  });

  afterEach(async () => {
    await app.close();
  });

  it("returns HTTP 404 for an unknown route", async () => {
    const res = await app.inject({ method: "GET", url: "/unknown-route" });
    expect(res.statusCode).toBe(404);
  });

  it("returns a JSON body for unknown routes", async () => {
    const res = await app.inject({ method: "GET", url: "/unknown-route" });
    expect(res.json<{ error: string }>()).toEqual({ error: "not found" });
  });
});

describe("Application — lifecycle", () => {
  it("closes cleanly without throwing", async () => {
    const app = await buildApp(config, { checkDb });
    await expect(app.close()).resolves.not.toThrow();
  });
});
