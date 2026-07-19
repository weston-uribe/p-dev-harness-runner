// Prerequisite: npx playwright install chromium
// Operator runtime: same launcher as `p-dev` / `npm start` (immutable next start).
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "@playwright/test";

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

export default defineConfig({
  testDir: path.join(repoRoot, "scripts"),
  testMatch: "workflow-browser-matrix.spec.ts",
  timeout: 120_000,
  workers: 1,
  use: {
    baseURL: "http://localhost:3100",
    screenshot: "only-on-failure",
    trace: "off",
  },
  webServer: {
    command:
      "P_DEV_OBSERVABILITY_DISABLED=1 P_DEV_OPERATIONS_FIXTURES=1 node bin/p-dev-dev.js --port 3100 --no-open",
    cwd: repoRoot,
    url: "http://localhost:3100/",
    reuseExistingServer: false,
    timeout: 420_000,
  },
  outputDir: "/tmp/workflow-validation/playwright-results",
});
