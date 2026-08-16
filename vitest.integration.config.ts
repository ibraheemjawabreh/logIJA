import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.integration.ts"],
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
