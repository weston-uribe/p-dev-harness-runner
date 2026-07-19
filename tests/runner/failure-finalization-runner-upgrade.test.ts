import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { finalizeFailedHarnessRun } from "../../src/runner/failure-finalization.js";
import { writeRunnerUpgradePendingStateAtomic } from "../../src/setup/runner-upgrade-pending-state.js";

vi.mock("../../src/linear/client.js", () => ({
  fetchLinearIssue: vi.fn(async () => ({
    id: "issue-1",
    identifier: "WES-1",
    title: "Test",
    state: { name: "Planning" },
  })),
}));

vi.mock("../../src/linear/writer.js", () => ({
  createLinearClient: vi.fn(() => ({})),
  transitionIssueStatus: vi.fn(async () => ({ transitioned: true })),
}));

vi.mock("../../src/linear/run-status-comment.js", () => ({
  markRunStatusBlocked: vi.fn(async () => ({ action: "created" as const })),
}));

describe("failure finalization during runner upgrade sync", () => {
  let workspaceDir = "";
  let jsonOutPath = "";
  let configPath = "";

  beforeEach(async () => {
    workspaceDir = await mkdtemp(path.join(tmpdir(), "failure-finalization-upgrade-"));
    await mkdir(path.join(workspaceDir, ".harness"), { recursive: true });
    await mkdir(path.join(workspaceDir, "runs"), { recursive: true });
    configPath = path.join(workspaceDir, ".harness", "config.local.json");
    jsonOutPath = path.join(workspaceDir, "runs", "manifest.json");
    await writeFile(
      configPath,
      `${JSON.stringify(
        {
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
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    await writeFile(
      jsonOutPath,
      `${JSON.stringify(
        {
          runId: "run-1",
          issueKey: "WES-1",
          phase: "none",
          status: "failed",
          errorClassification: "cloud_config_stale",
          validationSummary: "cloud_config_stale during sync",
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
  });

  afterEach(async () => {
    await rm(workspaceDir, { recursive: true, force: true });
  });

  it("does not Block Linear when cloud_config_stale during active runner upgrade sync", async () => {
    await writeRunnerUpgradePendingStateAtomic(
      {
        operationId: "op-1",
        repositoryId: 123,
        repoSlug: "owner/harness-repo",
        defaultBranch: "main",
        targetSnapshotContentId: "snap-1",
        phase: "synchronizing-cloud-configuration",
        startedAt: new Date().toISOString(),
        previewFingerprint: "fp",
        syncInProgress: true,
        codeUpdateComplete: true,
      },
      workspaceDir,
    );

    const { transitionIssueStatus } = await import("../../src/linear/writer.js");
    const result = await finalizeFailedHarnessRun({
      issueKey: "WES-1",
      jsonOutPath,
      exitCode: 1,
      configPath,
      linearApiKey: "linear-test-key",
    });

    expect(result.skipped).toBe(true);
    expect(result.blocked).toBe(false);
    expect(result.reason).toContain("temporarily allowed");
    expect(transitionIssueStatus).not.toHaveBeenCalled();
  });
});
