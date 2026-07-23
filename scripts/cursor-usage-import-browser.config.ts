// Prerequisite: npx playwright install chromium
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "@playwright/test";

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const workspaceDir = path.join(
  tmpdir(),
  `cursor-usage-browser-${process.pid}-${Date.now()}`,
);
const fakeLangfusePort = 18999;
const guiPort = 3131;
const fakeLangfuseBaseUrl = `http://127.0.0.1:${fakeLangfusePort}`;

/** Explicit isolated env — never inherit operator Langfuse credentials. */
const isolatedLangfuseEnv = {
  P_DEV_EVALUATION_PROVIDER: "langfuse",
  P_DEV_EVALUATION_NAMESPACE: "default",
  LANGFUSE_TRACING_ENVIRONMENT: "",
  LANGFUSE_PUBLIC_KEY: "pk-cursor-usage-e2e",
  LANGFUSE_SECRET_KEY: "sk-cursor-usage-e2e",
  LANGFUSE_BASE_URL: fakeLangfuseBaseUrl,
};

function stripOperatorLangfuse(
  env: NodeJS.ProcessEnv,
): Record<string, string | undefined> {
  const next: Record<string, string | undefined> = { ...env };
  for (const key of Object.keys(next)) {
    if (
      key.startsWith("LANGFUSE_") ||
      key.startsWith("P_DEV_EVALUATION_") ||
      key === "P_DEV_HOME" ||
      key === "HARNESS_CONFIG_PATH"
    ) {
      delete next[key];
    }
  }
  return next;
}

mkdirSync(path.join(workspaceDir, ".harness"), { recursive: true });
// Keep secrets out of the workspace .env.local file: Next.js RSC flight can
// embed readFile results from settings layout helpers. Credentials come only
// from the GUI process env below.
writeFileSync(
  path.join(workspaceDir, ".env.local"),
  [
    "HARNESS_CONFIG_PATH=.harness/config.local.json",
    `P_DEV_EVALUATION_PROVIDER=${isolatedLangfuseEnv.P_DEV_EVALUATION_PROVIDER}`,
    `P_DEV_EVALUATION_NAMESPACE=${isolatedLangfuseEnv.P_DEV_EVALUATION_NAMESPACE}`,
    `LANGFUSE_BASE_URL=${isolatedLangfuseEnv.LANGFUSE_BASE_URL}`,
  ].join("\n") + "\n",
);
execFileSync("git", ["init", "-q"], { cwd: workspaceDir });
execFileSync(
  "git",
  ["remote", "add", "origin", "https://github.com/example/cursor-usage-browser-fixture.git"],
  { cwd: workspaceDir },
);
writeFileSync(
  path.join(workspaceDir, ".harness/target-workflow-install.json"),
  `${JSON.stringify({ version: 1, status: "installed" }, null, 2)}\n`,
);
writeFileSync(
  path.join(workspaceDir, ".harness/config.local.json"),
  `${JSON.stringify({ version: 1, logDirectory: "runs", repos: [{ name: "fixture", path: "." }] }, null, 2)}\n`,
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
writeFileSync(
  path.join(workspaceDir, ".harness/control-plane-setup.json"),
  `${JSON.stringify(
    {
      version: 1,
      linearWorkspace: {
        workspaceId: "w",
        workspaceName: "W",
        teams: [
          {
            teamId: "t",
            teamKey: "TT",
            teamName: "Team",
            projects: [],
            health: "verification_pending",
          },
        ],
      },
      runnerUpgrade: {
        appliedSnapshotContentId: "abc",
        status: "up_to_date",
      },
    },
    null,
    2,
  )}\n`,
);

writeFileSync("/tmp/cursor-usage-browser-workspace.txt", `${workspaceDir}\n`, "utf8");
process.env.CURSOR_USAGE_BROWSER_WORKSPACE = workspaceDir;

const guiProcessEnv = {
  ...stripOperatorLangfuse(process.env),
  ...isolatedLangfuseEnv,
  P_DEV_HOME: workspaceDir,
  // gui:dev serves current source (operator .p-dev-runtime is git-HEAD fingerprint only).
  HARNESS_REPO_ROOT: repoRoot,
  HARNESS_GUI_PORT: String(guiPort),
  HARNESS_GUI_HOST: "127.0.0.1",
  // Prevent dotenv from reintroducing operator credentials via repo root.
  DOTENV_CONFIG_PATH: path.join(workspaceDir, ".env.local"),
};

export default defineConfig({
  testDir: path.join(repoRoot, "scripts"),
  testMatch: "cursor-usage-import-browser.spec.ts",
  timeout: 240_000,
  workers: 1,
  use: {
    baseURL: `http://127.0.0.1:${guiPort}`,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  webServer: [
    {
      command: `npx tsx scripts/cursor-usage-fake-langfuse-server.ts`,
      cwd: repoRoot,
      url: `${fakeLangfuseBaseUrl}/health`,
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        ...stripOperatorLangfuse(process.env),
        CURSOR_USAGE_FAKE_LANGFUSE_PORT: String(fakeLangfusePort),
      },
    },
    {
      command: `node bin/gui-dev.js --port ${guiPort} --no-open`,
      cwd: repoRoot,
      url: `http://127.0.0.1:${guiPort}/settings/cursor-usage`,
      reuseExistingServer: false,
      timeout: 420_000,
      env: guiProcessEnv,
    },
  ],
  outputDir: "/tmp/cursor-usage-browser/playwright-results",
});
