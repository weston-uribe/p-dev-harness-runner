import { afterEach, describe, expect, it, vi } from "vitest";
import { runSyncProductionCommand } from "../../src/cli/commands/sync-production.js";
import { EXIT_CONFIG, EXIT_SUCCESS } from "../../src/cli/exit-codes.js";
import type { HarnessConfig } from "../../src/config/types.js";
import * as issueQuery from "../../src/linear/issue-query.js";
import * as linearWriter from "../../src/linear/writer.js";

function privateTargetConfig(): HarnessConfig {
  return {
    version: 1,
    orchestratorMarker: "harness-orchestrator-v1",
    logDirectory: "runs",
    linear: { teamKey: "WES" },
    repos: [
      {
        id: "real-target",
        linearProjects: ["Private Target"],
        targetRepo: "https://github.com/owner/private-target",
        baseBranch: "dev",
        productionBranch: "main",
        integrationSuccessStatus: "Merged to Dev",
      },
    ],
    allowedTargetRepos: ["https://github.com/owner/private-target"],
  };
}

describe("runSyncProductionCommand dispatch validation", () => {
  afterEach(() => {
    process.argv = ["node", "harness", "sync-production"];
    delete process.env.HARNESS_CONFIG_JSON;
    delete process.env.LINEAR_API_KEY;
    delete process.env.GITHUB_TOKEN;
    vi.restoreAllMocks();
  });

  it("accepts real-target when present in injected config", async () => {
    process.argv = ["node", "harness", "sync-production"];
    process.env.HARNESS_CONFIG_JSON = JSON.stringify(privateTargetConfig());
    process.env.LINEAR_API_KEY = "test-linear";
    process.env.GITHUB_TOKEN = "test-github";

    vi.spyOn(linearWriter, "createLinearClient").mockReturnValue({
      teams: vi.fn().mockResolvedValue({ nodes: [{ id: "t1", key: "WES" }] }),
    } as never);
    vi.spyOn(issueQuery, "listIssuesByStatus").mockResolvedValue([]);

    const exitCode = await runSyncProductionCommand({
      configPath: "harness.config.json",
      repo: "real-target",
      sourceRepo: "owner/private-target",
      productionBranch: "main",
      ref: "refs/heads/main",
      json: true,
    });

    expect(exitCode).toBe(EXIT_SUCCESS);
  });

  it("rejects real-target when absent from injected config", async () => {
    process.argv = ["node", "harness", "sync-production"];
    process.env.HARNESS_CONFIG_JSON = JSON.stringify({
      version: 1,
      orchestratorMarker: "harness-orchestrator-v1",
      logDirectory: "runs",
      repos: [
        {
          id: "target-app",
          targetRepo: "https://github.com/owner/example-target-app",
          baseBranch: "main",
          productionBranch: "main",
        },
      ],
      allowedTargetRepos: ["https://github.com/owner/example-target-app"],
    });
    process.env.LINEAR_API_KEY = "test-linear";
    process.env.GITHUB_TOKEN = "test-github";

    const exitCode = await runSyncProductionCommand({
      configPath: "harness.config.json",
      repo: "real-target",
      json: true,
    });

    expect(exitCode).toBe(EXIT_CONFIG);
  });

  it("rejects sourceRepo mismatch", async () => {
    process.argv = ["node", "harness", "sync-production"];
    process.env.HARNESS_CONFIG_JSON = JSON.stringify(privateTargetConfig());
    process.env.LINEAR_API_KEY = "test-linear";
    process.env.GITHUB_TOKEN = "test-github";

    const exitCode = await runSyncProductionCommand({
      configPath: "harness.config.json",
      repo: "real-target",
      sourceRepo: "owner/wrong-target",
      json: true,
    });

    expect(exitCode).toBe(EXIT_CONFIG);
  });
});
