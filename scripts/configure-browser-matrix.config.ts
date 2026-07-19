// Prerequisite: npx playwright install chromium
import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "@playwright/test";

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const workspaceDir = execSync("npx tsx scripts/prepare-configure-browser-workspace.ts", {
  cwd: repoRoot,
  encoding: "utf8",
}).trim();
const workspaceMarkerPath = "/tmp/configure-browser-workspace-path.txt";

writeFileSync(workspaceMarkerPath, `${workspaceDir}\n`, "utf8");
process.env.CONFIGURE_BROWSER_WORKSPACE = workspaceDir;

export default defineConfig({
  testDir: path.join(repoRoot, "scripts"),
  testMatch: "configure-browser-matrix.spec.ts",
  timeout: 120_000,
  workers: 1,
  use: {
    baseURL: "http://localhost:3101",
    screenshot: "only-on-failure",
    trace: "off",
  },
  webServer: {
    command: [
      `P_DEV_HOME=${workspaceDir}`,
      "P_DEV_OBSERVABILITY_DISABLED=1",
      "node bin/p-dev-dev.js --port 3101 --no-open",
    ].join(" "),
    cwd: repoRoot,
    url: "http://localhost:3101/",
    reuseExistingServer: false,
    timeout: 300_000,
  },
  outputDir: "/tmp/configure-validation/playwright-results",
});
