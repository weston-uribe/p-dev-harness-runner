import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  EXIT_CONFIG,
  EXIT_RUN_FAILURE,
  EXIT_SUCCESS,
} from "../../src/cli/exit-codes.js";
import type { ProductionSyncIssueResult } from "../../src/runner/phases/production-sync.js";
import type { RunManifest } from "../../src/types/run.js";

const mocks = vi.hoisted(() => ({
  listProductionSyncIssueKeysForRepo: vi.fn(),
  fetchLinearIssue: vi.fn(),
  executeProductionSyncForIssue: vi.fn(),
}));

vi.mock("../../src/runner/production-sync-candidates.js", () => ({
  listProductionSyncIssueKeysForRepo: mocks.listProductionSyncIssueKeysForRepo,
}));

vi.mock("../../src/linear/client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/linear/client.js")>();
  return {
    ...actual,
    fetchLinearIssue: mocks.fetchLinearIssue,
  };
});

vi.mock("../../src/runner/phases/production-sync.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/runner/phases/production-sync.js")>();
  return {
    ...actual,
    executeProductionSyncForIssue: mocks.executeProductionSyncForIssue,
  };
});

import { runSyncProductionCommand } from "../../src/cli/commands/sync-production.js";

function portfolioConfig() {
  return {
    version: 1,
    orchestratorMarker: "harness-orchestrator-v1",
    logDirectory: "runs",
    linear: { teamKey: "WES" },
    repos: [
      {
        id: "portfolio",
        linearProjects: ["Example Target App"],
        targetRepo: "https://github.com/owner/example-target-app",
        baseBranch: "dev",
        productionBranch: "main",
        integrationSuccessStatus: "Merged to Dev",
        productionSuccessStatus: "Merged / Deployed",
      },
    ],
    allowedTargetRepos: ["https://github.com/owner/example-target-app"],
  };
}

function linearIssue(identifier: string) {
  return {
    id: `id-${identifier}`,
    identifier,
    title: `${identifier} production sync fixture`,
    description: [
      "## Target repo",
      "",
      "owner/example-target-app",
      "",
      "## Task",
      "",
      "Sync production projection fixture.",
      "",
      "## Acceptance criteria",
      "",
      "- [ ] Done",
      "",
      "## Out of scope",
      "",
      "- None",
      "",
      "## Validation expectations",
      "",
      "- npm test",
    ].join("\n"),
    status: "Merged to Dev",
    projectName: "Example Target App",
    teamName: "WES",
    teamKey: "WES",
    teamId: "team-1",
    url: null,
  };
}

function phaseResult(
  finalOutcome: RunManifest["finalOutcome"],
  errorClassification: RunManifest["errorClassification"] = null,
  extras: Partial<ProductionSyncIssueResult> = {},
): ProductionSyncIssueResult {
  return {
    manifest: {
      finalOutcome,
      errorClassification,
    } as RunManifest,
    runDirectory: "/tmp/unused-run",
    exitCode: finalOutcome === "failed" ? 2 : 0,
    skippedReason:
      finalOutcome === "duplicate"
        ? "duplicate_phase_completed: durable completion already complete"
        : finalOutcome === "skipped"
          ? "missing_merge_metadata"
          : finalOutcome === "failed"
            ? "langfuse_projection_failure"
            : undefined,
    productionCompletionId: "completion-fixture",
    productionState: finalOutcome === "success" ? "completed" : "promotion_proven",
    ...extras,
  };
}

describe("runSyncProductionCommand exit semantics", () => {
  let tempRoot = "";

  beforeEach(async () => {
    tempRoot = await mkdtemp(path.join(tmpdir(), "sync-exit-"));
    process.env.HARNESS_CONFIG_JSON = JSON.stringify(portfolioConfig());
    process.env.LINEAR_API_KEY = "test-linear";
    process.env.GITHUB_TOKEN = "test-github";
    mocks.listProductionSyncIssueKeysForRepo.mockReset();
    mocks.fetchLinearIssue.mockReset();
    mocks.executeProductionSyncForIssue.mockReset();
    mocks.fetchLinearIssue.mockImplementation(async (issueKey: string) =>
      linearIssue(issueKey),
    );
  });

  afterEach(async () => {
    delete process.env.HARNESS_CONFIG_JSON;
    delete process.env.LINEAR_API_KEY;
    delete process.env.GITHUB_TOKEN;
    vi.restoreAllMocks();
    await rm(tempRoot, { recursive: true, force: true });
  });

  it("returns EXIT_SUCCESS for zero candidates and writes valid JSON", async () => {
    mocks.listProductionSyncIssueKeysForRepo.mockResolvedValue([]);
    const jsonOut = path.join(tempRoot, "zero.json");

    const exitCode = await runSyncProductionCommand({
      configPath: "harness.config.json",
      repo: "portfolio",
      jsonOut,
    });

    expect(exitCode).toBe(EXIT_SUCCESS);
    const parsed = JSON.parse(await readFile(jsonOut, "utf8")) as {
      issuesInspected: number;
      issuesFailed: number;
      results: unknown[];
    };
    expect(parsed.issuesInspected).toBe(0);
    expect(parsed.issuesFailed).toBe(0);
    expect(parsed.results).toEqual([]);
    expect(mocks.executeProductionSyncForIssue).not.toHaveBeenCalled();
  });

  it("returns EXIT_SUCCESS for one successful candidate", async () => {
    mocks.listProductionSyncIssueKeysForRepo.mockResolvedValue(["WES-1"]);
    mocks.executeProductionSyncForIssue.mockResolvedValue(
      phaseResult("success"),
    );
    const jsonOut = path.join(tempRoot, "success.json");

    const exitCode = await runSyncProductionCommand({
      configPath: "harness.config.json",
      repo: "portfolio",
      jsonOut,
    });

    expect(exitCode).toBe(EXIT_SUCCESS);
    const parsed = JSON.parse(await readFile(jsonOut, "utf8")) as {
      issuesUpdated: number;
      issuesFailed: number;
      results: Array<{ finalOutcome: string }>;
    };
    expect(parsed.issuesUpdated).toBe(1);
    expect(parsed.issuesFailed).toBe(0);
    expect(parsed.results[0]?.finalOutcome).toBe("success");
  });

  it("returns EXIT_SUCCESS for duplicate-only candidates", async () => {
    mocks.listProductionSyncIssueKeysForRepo.mockResolvedValue(["WES-1"]);
    mocks.executeProductionSyncForIssue.mockResolvedValue(
      phaseResult("duplicate", "duplicate_phase_completed"),
    );
    const jsonOut = path.join(tempRoot, "duplicate.json");

    const exitCode = await runSyncProductionCommand({
      configPath: "harness.config.json",
      repo: "portfolio",
      jsonOut,
    });

    expect(exitCode).toBe(EXIT_SUCCESS);
    const parsed = JSON.parse(await readFile(jsonOut, "utf8")) as {
      issuesSkipped: number;
      issuesFailed: number;
      results: Array<{ finalOutcome: string }>;
    };
    expect(parsed.issuesSkipped).toBe(1);
    expect(parsed.issuesFailed).toBe(0);
    expect(parsed.results[0]?.finalOutcome).toBe("duplicate");
  });

  it("returns EXIT_SUCCESS for skipped-only candidates", async () => {
    mocks.listProductionSyncIssueKeysForRepo.mockResolvedValue(["WES-1"]);
    mocks.executeProductionSyncForIssue.mockResolvedValue(
      phaseResult("skipped", "missing_merge_metadata"),
    );
    const jsonOut = path.join(tempRoot, "skipped.json");

    const exitCode = await runSyncProductionCommand({
      configPath: "harness.config.json",
      repo: "portfolio",
      jsonOut,
    });

    expect(exitCode).toBe(EXIT_SUCCESS);
    const parsed = JSON.parse(await readFile(jsonOut, "utf8")) as {
      issuesSkipped: number;
      issuesFailed: number;
      results: Array<{ finalOutcome: string }>;
    };
    expect(parsed.issuesSkipped).toBe(1);
    expect(parsed.issuesFailed).toBe(0);
    expect(parsed.results[0]?.finalOutcome).toBe("skipped");
  });

  it("returns EXIT_RUN_FAILURE for one failed issue result and writes complete JSON", async () => {
    mocks.listProductionSyncIssueKeysForRepo.mockResolvedValue(["WES-1"]);
    mocks.executeProductionSyncForIssue.mockResolvedValue(
      phaseResult("failed", "langfuse_projection_failure"),
    );
    const jsonOut = path.join(tempRoot, "failed.json");

    const exitCode = await runSyncProductionCommand({
      configPath: "harness.config.json",
      repo: "portfolio",
      jsonOut,
    });

    expect(exitCode).toBe(EXIT_RUN_FAILURE);
    const parsed = JSON.parse(await readFile(jsonOut, "utf8")) as {
      issuesFailed: number;
      results: Array<{
        issueKey: string;
        finalOutcome: string;
        errorClassification: string | null;
      }>;
    };
    expect(parsed.issuesFailed).toBe(1);
    expect(parsed.results).toHaveLength(1);
    expect(parsed.results[0]).toMatchObject({
      issueKey: "WES-1",
      finalOutcome: "failed",
      errorClassification: "langfuse_projection_failure",
    });
  });

  it("returns EXIT_RUN_FAILURE for mixed success and failure and preserves all results", async () => {
    mocks.listProductionSyncIssueKeysForRepo.mockResolvedValue([
      "WES-1",
      "WES-2",
    ]);
    mocks.executeProductionSyncForIssue
      .mockResolvedValueOnce(phaseResult("success"))
      .mockResolvedValueOnce(phaseResult("failed", "linear_comment_failure"));
    const jsonOut = path.join(tempRoot, "mixed.json");

    const exitCode = await runSyncProductionCommand({
      configPath: "harness.config.json",
      repo: "portfolio",
      jsonOut,
    });

    expect(exitCode).toBe(EXIT_RUN_FAILURE);
    const parsed = JSON.parse(await readFile(jsonOut, "utf8")) as {
      issuesInspected: number;
      issuesUpdated: number;
      issuesFailed: number;
      results: Array<{
        issueKey: string;
        finalOutcome: string;
        errorClassification?: string | null;
      }>;
    };
    expect(parsed.issuesInspected).toBe(2);
    expect(parsed.issuesUpdated).toBe(1);
    expect(parsed.issuesFailed).toBe(1);
    expect(parsed.results).toEqual([
      expect.objectContaining({
        issueKey: "WES-1",
        finalOutcome: "success",
      }),
      expect.objectContaining({
        issueKey: "WES-2",
        finalOutcome: "failed",
        errorClassification: "linear_comment_failure",
      }),
    ]);
  });

  it("returns EXIT_RUN_FAILURE when a per-issue exception is caught and still writes JSON", async () => {
    mocks.listProductionSyncIssueKeysForRepo.mockResolvedValue(["WES-1"]);
    mocks.executeProductionSyncForIssue.mockRejectedValue(
      new Error("simulated phase crash"),
    );
    const jsonOut = path.join(tempRoot, "exception.json");

    const exitCode = await runSyncProductionCommand({
      configPath: "harness.config.json",
      repo: "portfolio",
      jsonOut,
    });

    expect(exitCode).toBe(EXIT_RUN_FAILURE);
    const parsed = JSON.parse(await readFile(jsonOut, "utf8")) as {
      issuesFailed: number;
      results: Array<{
        issueKey: string;
        finalOutcome: string;
        skippedReason?: string;
      }>;
    };
    expect(parsed.issuesFailed).toBe(1);
    expect(parsed.results[0]).toMatchObject({
      issueKey: "WES-1",
      finalOutcome: "failed",
      skippedReason: "simulated phase crash",
    });
  });

  it("returns EXIT_CONFIG when --json-out write fails because parent dir is missing", async () => {
    mocks.listProductionSyncIssueKeysForRepo.mockResolvedValue([]);
    const jsonOut = path.join(tempRoot, "missing-parent", "out.json");

    const exitCode = await runSyncProductionCommand({
      configPath: "harness.config.json",
      repo: "portfolio",
      jsonOut,
    });

    expect(exitCode).toBe(EXIT_CONFIG);
    expect(exitCode).not.toBe(EXIT_RUN_FAILURE);
  });
});
