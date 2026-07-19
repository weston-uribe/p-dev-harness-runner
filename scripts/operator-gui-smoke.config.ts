// Prerequisite: npx playwright install chromium
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "@playwright/test";

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const workspaceDir = path.join(
  tmpdir(),
  `operator-gui-smoke-${process.pid}-${Date.now()}`,
);
mkdirSync(path.join(workspaceDir, ".harness"), { recursive: true });
// Empty operator workspace → Configure route (no live provider tokens).
writeFileSync(path.join(workspaceDir, ".env.local"), "HARNESS_CONFIG_PATH=.harness/config.local.json\n");
writeFileSync(
  path.join(workspaceDir, ".harness/config.local.json"),
  `${JSON.stringify({ version: 1, repos: [] }, null, 2)}\n`,
);
writeFileSync(
  path.join(workspaceDir, ".harness/observability.local.json"),
  `${JSON.stringify(
    {
      schemaVersion: 1,
      analyticsPreference: "disabled",
      errorReportingPreference: "disabled",
      disclosureShown: true,
    },
    null,
    2,
  )}\n`,
);

writeFileSync("/tmp/operator-gui-smoke-workspace.txt", `${workspaceDir}\n`, "utf8");
process.env.OPERATOR_GUI_SMOKE_WORKSPACE = workspaceDir;

export default defineConfig({
  testDir: path.join(repoRoot, "scripts"),
  testMatch: "operator-gui-smoke.spec.ts",
  timeout: 180_000,
  workers: 1,
  use: {
    baseURL: "http://localhost:3120",
    screenshot: "only-on-failure",
    trace: "off",
  },
  webServer: {
    command: [
      `P_DEV_HOME=${workspaceDir}`,
      "P_DEV_OBSERVABILITY_DISABLED=1",
      "node bin/p-dev-dev.js --port 3120 --no-open",
    ].join(" "),
    cwd: repoRoot,
    url: "http://localhost:3120/",
    reuseExistingServer: false,
    timeout: 420_000,
  },
  outputDir: "/tmp/operator-gui-smoke/playwright-results",
});
