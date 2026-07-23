import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GitHubApiError } from "../../src/github/client.js";
import type { PrInspectionResult } from "../../src/github/pr-inspector.js";
import type { HarnessConfig } from "../../src/config/types.js";
import type { ParsedIssue } from "../../src/types/parsed-issue.js";
import type { ResolvedTarget } from "../../src/resolver/target-repo.js";

const mocks = vi.hoisted(() => ({
  postIssueComment: vi.fn().mockResolvedValue("comment-1"),
  listIssueComments: vi.fn().mockResolvedValue([]),
  acquireBuilderAgent: vi.fn(),
  disposeAgent: vi.fn().mockResolvedValue(undefined),
  sendAndObserve: vi.fn(),
}));

vi.mock("../../src/linear/writer.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/linear/writer.js")>();
  return {
    ...actual,
    postIssueComment: mocks.postIssueComment,
    listIssueComments: mocks.listIssueComments,
  };
});

vi.mock("../../src/agents/production.js", () => ({
  acquireBuilderAgent: mocks.acquireBuilderAgent,
  disposeAgent: mocks.disposeAgent,
  sendAndObserve: mocks.sendAndObserve,
}));

import { attemptIntegrationRepair } from "../../src/runner/phases/integration-repair.js";

const targetRepo = "https://github.com/owner/example-target-app";

function makeInspection(overrides: Partial<PrInspectionResult> = {}): PrInspectionResult {
  return {
    title: "[WES-23] Repair",
    url: `${targetRepo}/pull/23`,
    branch: "cursor/wes-23-test",
    headSha: "dirty-sha",
    baseBranch: "dev",
    state: "open",
    merged: false,
    isDraft: false,
    mergeable: false,
    mergeableState: "dirty",
    rebaseable: false,
    mergeCommitSha: null,
    mergedAt: null,
    repoUrl: targetRepo,
    changedFiles: [{ path: "app/shell.tsx", status: "modified" }],
    checks: [{ name: "CI", status: "completed", conclusion: "success", detailsUrl: null }],
    checkSummary: "- Passed: 1",
    comments: [],
    rawChecks: [],
    ...overrides,
  };
}

function makeConfig(): HarnessConfig {
  return {
    version: 1,
    orchestratorMarker: "harness-orchestrator-v1",
    logDirectory: "runs",
    defaultModel: { id: "composer-2.5" },
    merge: { allowUnknownChecks: true, deploymentPollIntervalSeconds: 0 },
    repos: [
      {
        id: "target-app",
        targetRepo,
        baseBranch: "dev",
        productionBranch: "main",
        validation: { commands: ["npm test"] },
      },
    ],
    allowedTargetRepos: [targetRepo],
  } as HarnessConfig;
}

const parsedIssue: ParsedIssue = {
  targetRepo: "owner/example-target-app",
  task: "Resolve merge queue conflict.",
  acceptanceCriteria: ["PR merges"],
  outOfScope: ["New product behavior"],
  validationExpectations: "Run tests.",
};

const resolved: ResolvedTarget = {
  targetRepo,
  repoConfigId: "target-app",
  baseBranch: "dev",
  productionBranch: "main",
  resolutionSource: "explicit",
};

function makeOptions(
  github: Record<string, unknown>,
  runDirectory: string,
  initialInspection = makeInspection(),
) {
  return {
    github: github as never,
    linearClient: {} as never,
    issue: {
      id: "issue-1",
      identifier: "WES-23",
      title: "Repair conflict",
      status: "Merging",
      teamId: "team-1",
    },
    config: makeConfig(),
    parsedIssue,
    resolved,
    parsedPr: {
      owner: "weston-uribe",
      repo: "example-target-app",
      pullNumber: 23,
      repoUrl: targetRepo,
    },
    markerTargetRepo: targetRepo,
    runId: "run-1",
    runDirectory,
    events: { log: vi.fn().mockResolvedValue(undefined) },
    model: "composer-2.5",
    initialInspection,
    cursorApiKey: "cursor-key",
  };
}

describe("attemptIntegrationRepair", () => {
  let tempRoot = "";

  beforeEach(async () => {
    vi.clearAllMocks();
    tempRoot = await mkdtemp(path.join(tmpdir(), "harness-repair-"));
  });

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  it("uses deterministic update-branch before agent repair", async () => {
    const github = {
      getRepository: vi.fn().mockResolvedValue({ permissions: { push: true } }),
      updatePullRequestBranch: vi.fn().mockResolvedValue({ message: "accepted" }),
      getPullRequest: vi.fn().mockResolvedValue({
        title: "[WES-23] Repair",
        html_url: `${targetRepo}/pull/23`,
        head: { ref: "cursor/wes-23-test", sha: "clean-sha" },
        base: { ref: "dev" },
        state: "open",
        merged: false,
        draft: false,
        mergeable: true,
        mergeable_state: "clean",
        rebaseable: true,
        merged_at: null,
        merge_commit_sha: null,
      }),
      getPullRequestFiles: vi
        .fn()
        .mockResolvedValue([{ filename: "app/shell.tsx", status: "modified" }]),
      getCheckRunsForRef: vi.fn().mockResolvedValue({
        check_runs: [
          {
            name: "CI",
            status: "completed",
            conclusion: "success",
            details_url: null,
          },
        ],
      }),
      getIssueComments: vi.fn().mockResolvedValue([]),
    };

    const result = await attemptIntegrationRepair(makeOptions(github, tempRoot));

    expect(github.updatePullRequestBranch).toHaveBeenCalledWith(
      "weston-uribe",
      "example-target-app",
      23,
      { expectedHeadSha: "dirty-sha" },
    );
    expect(mocks.acquireBuilderAgent).not.toHaveBeenCalled();
    expect(result.inspection.mergeableState).toBe("clean");
  });

  it("blocks when agent touches unrelated files", async () => {
    const github = {
      getRepository: vi.fn().mockResolvedValue({ permissions: { push: true } }),
      updatePullRequestBranch: vi
        .fn()
        .mockRejectedValue(new GitHubApiError(422, "conflicts")),
      getBranchRef: vi.fn().mockResolvedValue({ object: { sha: "base-sha" } }),
      getPullRequest: vi
        .fn()
        .mockResolvedValueOnce({
          title: "[WES-23] Repair",
          html_url: `${targetRepo}/pull/23`,
          head: { ref: "cursor/wes-23-test", sha: "dirty-sha" },
          base: { ref: "dev" },
          state: "open",
          merged: false,
          draft: false,
          mergeable: false,
          mergeable_state: "dirty",
          rebaseable: false,
          merged_at: null,
          merge_commit_sha: null,
        })
        .mockResolvedValue({
          title: "[WES-23] Repair",
          html_url: `${targetRepo}/pull/23`,
          head: { ref: "cursor/wes-23-test", sha: "agent-sha" },
          base: { ref: "dev" },
          state: "open",
          merged: false,
          draft: false,
          mergeable: true,
          mergeable_state: "clean",
          rebaseable: true,
          merged_at: null,
          merge_commit_sha: null,
        }),
      getPullRequestFiles: vi
        .fn()
        .mockResolvedValue([{ filename: "app/shell.tsx", status: "modified" }]),
      getCheckRunsForRef: vi.fn().mockResolvedValue({
        check_runs: [
          {
            name: "CI",
            status: "completed",
            conclusion: "success",
            details_url: null,
          },
        ],
      }),
      getIssueComments: vi.fn().mockResolvedValue([]),
    };
    mocks.acquireBuilderAgent.mockResolvedValue({
      agent: {
        agentId: "agent-1",
        [Symbol.asyncDispose]: async () => undefined,
      },
      continuity: {
        action: "resumed",
        reference: {
          agentId: "agent-1",
          generation: 1,
          originHarnessRunId: "impl-1",
          latestHarnessRunId: "merge-1",
          sourcePhase: "integration_repair",
          targetRepo,
        },
      },
    });
    mocks.sendAndObserve.mockResolvedValue({
      agentId: "agent-1",
      runId: "run-2",
      result: { status: "finished" },
      assistantText:
        '```json\n{"status":"success","touched_files":[{"path":"README.md","category":"conflict","reason":"cleanup"}]}\n```',
      gitResult: {
        repoUrl: targetRepo,
        branch: "cursor/wes-23-test",
        prUrl: `${targetRepo}/pull/23`,
      },
      cancelOutcome: null,
    });

    await expect(attemptIntegrationRepair(makeOptions(github, tempRoot))).rejects.toMatchObject({
      classification: "repair_scope_violation",
    });
  });
});
