import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "apps/gui"),
      "@harness": path.resolve(__dirname, "src"),
    },
  },
  test: {
    include: ["tests/**/*.test.ts"],
    setupFiles: ["tests/setup/mock-canonical-preflight.ts"],
    environment: "node",
    hookTimeout: 300_000,
    testTimeout: 120_000,
    maxWorkers: process.env.CI ? 1 : undefined,
    fileParallelism: process.env.CI ? false : undefined,
  },
});
