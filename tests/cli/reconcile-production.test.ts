import { afterEach, describe, expect, it, vi } from "vitest";
import { runReconcileProductionCommand } from "../../src/cli/commands/reconcile-production.js";
import * as syncProduction from "../../src/cli/commands/sync-production.js";
import { EXIT_CONFIG, EXIT_SUCCESS } from "../../src/cli/exit-codes.js";

describe("runReconcileProductionCommand", () => {
  afterEach(() => {
    delete process.env.HARNESS_CONFIG_JSON;
    delete process.env.LINEAR_API_KEY;
    delete process.env.GITHUB_TOKEN;
    vi.restoreAllMocks();
  });

  function injectConfig(): void {
    process.env.HARNESS_CONFIG_JSON = JSON.stringify({
      version: 1,
      orchestratorMarker: "harness-orchestrator-v1",
      logDirectory: "runs",
      linear: { teamKey: "WES" },
      repos: [
        {
          id: "portfolio",
          targetRepo: "https://github.com/owner/portfolio",
          baseBranch: "dev",
          productionBranch: "main",
        },
        {
          id: "same-branch",
          targetRepo: "https://github.com/owner/same",
          baseBranch: "main",
          productionBranch: "main",
        },
      ],
      allowedTargetRepos: [
        "https://github.com/owner/portfolio",
        "https://github.com/owner/same",
      ],
    });
    process.env.LINEAR_API_KEY = "lin";
    process.env.GITHUB_TOKEN = "gh";
  }

  it("invokes the same sync core path per configured production repo", async () => {
    injectConfig();

    const execute = vi
      .spyOn(syncProduction, "executeSyncProduction")
      .mockResolvedValue({
        repoId: "portfolio",
        issuesInspected: 0,
        issuesUpdated: 0,
        issuesSkipped: 0,
        issuesFailed: 0,
        results: [],
      });

    const exitCode = await runReconcileProductionCommand({
      configPath: "harness.config.json",
      json: true,
    });

    expect(exitCode).toBe(EXIT_SUCCESS);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]?.[0]?.repo).toBe("portfolio");
  });

  it("returns EXIT_CONFIG when any repo summary has issuesFailed > 0", async () => {
    injectConfig();

    vi.spyOn(syncProduction, "executeSyncProduction").mockResolvedValue({
      repoId: "portfolio",
      issuesInspected: 1,
      issuesUpdated: 0,
      issuesSkipped: 0,
      issuesFailed: 1,
      results: [
        {
          issueKey: "WES-1",
          finalOutcome: "failed",
          errorClassification: "langfuse_projection_failure",
        },
      ],
    });

    const exitCode = await runReconcileProductionCommand({
      configPath: "harness.config.json",
      json: true,
    });

    expect(exitCode).toBe(EXIT_CONFIG);
    expect(exitCode).not.toBe(EXIT_SUCCESS);
  });
});
