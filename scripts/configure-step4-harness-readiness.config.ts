import { execSync } from "node:child_process";
import { copyFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "@playwright/test";

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const workspaceDir = execSync("npx tsx scripts/prepare-configure-browser-workspace.ts", {
  cwd: repoRoot,
  encoding: "utf8",
}).trim();

copyFileSync(
  path.join(repoRoot, ".env.example"),
  path.join(workspaceDir, ".env.example"),
);
copyFileSync(
  path.join(repoRoot, ".harness/config.example.json"),
  path.join(workspaceDir, ".harness/config.example.json"),
);

writeFileSync(
  path.join(workspaceDir, ".env.local"),
  [
    "HARNESS_CONFIG_PATH=.harness/config.local.json",
    "GITHUB_DISPATCH_REPOSITORY=weston-uribe/agentic-product-development-harness",
    "LINEAR_API_KEY=lin_test_key",
    "CURSOR_API_KEY=crsr_test_key",
    "GITHUB_TOKEN=ghp_test_key",
    "VERCEL_TOKEN=vcp_test_key",
  ].join("\n"),
  "utf8",
);
writeFileSync(
  path.join(workspaceDir, ".harness/control-plane-setup.json"),
  `${JSON.stringify(
    {
      version: 1,
      linear: {
        teamMode: "existing",
        teamId: "team-1",
        teamKey: "ENG",
        teamName: "Engineering",
        projectMode: "existing",
        projectId: "proj-1",
        projectName: "Harness",
        statusCoverageComplete: true,
        appliedAt: "2026-07-16T00:00:00.000Z",
      },
      vercel: {
        projectId: "prj-1",
        projectName: "harness-bridge",
        productionUrl: "https://harness-bridge.vercel.app",
        webhookUrl: "https://harness-bridge.vercel.app/api/linear-webhook",
        endpointReachable: true,
        envVarPresence: {
          LINEAR_WEBHOOK_SECRET: "present",
          GITHUB_DISPATCH_TOKEN: "present",
          HARNESS_TEAM_KEY: "present",
        },
        linearWebhookVerified: true,
        signedProbeVerified: true,
        deploymentRedeployRequired: false,
        appliedAt: "2026-07-16T00:00:00.000Z",
      },
    },
    null,
    2,
  )}\n`,
  "utf8",
);
try {
  unlinkSync(path.join(workspaceDir, ".harness/config.local.json"));
} catch {
  // Step 4 runs before local config files exist.
}
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
  "utf8",
);

process.env.CONFIGURE_STEP4_WORKSPACE = workspaceDir;

export default defineConfig({
  testDir: path.join(repoRoot, "scripts"),
  testMatch: "configure-step4-harness-readiness.spec.ts",
  timeout: 120_000,
  workers: 1,
  use: {
    baseURL: "http://localhost:3110",
    screenshot: "only-on-failure",
    trace: "off",
  },
  webServer: {
    command: [
      `P_DEV_HOME=${workspaceDir}`,
      "P_DEV_OBSERVABILITY_DISABLED=1",
      "CONFIGURE_BROWSER_SKIP_DISCLOSURE=1",
      "node bin/p-dev-dev.js --port 3110 --no-open",
    ].join(" "),
    cwd: repoRoot,
    url: "http://localhost:3110/",
    reuseExistingServer: false,
    timeout: 300_000,
  },
  outputDir: "/tmp/configure-step4-readiness/playwright-results",
});
