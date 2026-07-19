import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  transitionIssueStatus: vi.fn(),
  postMergeCompletionComment: vi.fn(),
  postPhaseStartCommentIfNeeded: vi.fn(),
  postErrorComment: vi.fn(),
  listIssueComments: vi.fn(),
  createLinearClient: vi.fn(),
  fetchLinearIssue: vi.fn(),
  inspectPullRequestForMerge: vi.fn(),
  inspectPullRequestPostMerge: vi.fn(),
  mergePullRequest: vi.fn(),
  markPullRequestReadyForReview: vi.fn(),
  pollForProductionDeployment: vi.fn(),
  attemptIntegrationRepair: vi.fn(),
}));

vi.mock("../../src/linear/writer.js", () => ({
  transitionIssueStatus: mocks.transitionIssueStatus,
  postMergeCompletionComment: mocks.postMergeCompletionComment,
  postPhaseStartCommentIfNeeded: mocks.postPhaseStartCommentIfNeeded,
  postErrorComment: mocks.postErrorComment,
  listIssueComments: mocks.listIssueComments,
  createLinearClient: mocks.createLinearClient,
}));

vi.mock("../../src/linear/client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/linear/client.js")>();
  return {
    ...actual,
    fetchLinearIssue: mocks.fetchLinearIssue,
  };
});

vi.mock("../../src/github/pr-inspector.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/github/pr-inspector.js")>();
  return {
    ...actual,
    inspectPullRequestForMerge: mocks.inspectPullRequestForMerge,
    inspectPullRequestPostMerge: mocks.inspectPullRequestPostMerge,
  };
});

vi.mock("../../src/github/client.js", () => ({
  GitHubClient: vi.fn().mockImplementation(() => ({
    mergePullRequest: mocks.mergePullRequest,
    markPullRequestReadyForReview: mocks.markPullRequestReadyForReview,
    getBranchRef: vi.fn().mockResolvedValue({ object: { sha: "abc123" } }),
  })),
  GitHubApiError: class GitHubApiError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
    }
  },
}));

vi.mock("../../src/preview/production-from-merge.js", () => ({
  pollForProductionDeployment: mocks.pollForProductionDeployment,
  inferVercelReadyFromComments: vi.fn(() => false),
}));

vi.mock("../../src/runner/phases/integration-repair.js", () => ({
  attemptIntegrationRepair: mocks.attemptIntegrationRepair,
}));

vi.mock("../../src/product/read-product-marker.js", () => ({
  readProductMarker: vi.fn().mockResolvedValue({
    content: null,
    markerPath: ".p-dev/product.json",
    developmentBranch: "dev",
  }),
}));

vi.mock("../../src/github/base-branch.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/github/base-branch.js")>();
  return {
    ...actual,
    assertBaseBranchExists: vi.fn().mockResolvedValue(undefined),
  };
});

import { executeMergePhase } from "../../src/runner/phases/merge.js";
import type { HarnessConfig } from "../../src/config/types.js";

const revisionCommentBody = `## PM revision
---
harness-orchestrator-v1
phase: revision
run_id: 2026-07-07T05-36-17-216Z-WES-13
model: composer-2.5
prompt_version: revision@1
target_repo: https://github.com/owner/example-target-app
branch: cursor/wes-13-test
pr_url: https://github.com/owner/example-target-app/pull/4
previous_handoff_run_id: 2026-07-07T05-13-15-231Z-WES-13
pm_feedback_comment_id: feedback-1
---`;

const issueDescription = `## Target repo

owner/example-target-app

## Task

Merge test issue.

## Acceptance criteria

- [ ] PR merged

## Out of scope

- [ ] New implementation

## Validation expectations

Run npm run lint and npm run build.`;

describe("executeMergePhase", () => {
  let tempRoot = "";
  let configPath = "";

  beforeEach(async () => {
    vi.clearAllMocks();
    process.env.LINEAR_API_KEY = "test-linear";
    process.env.GITHUB_TOKEN = "test-github";
    tempRoot = await mkdtemp(path.join(tmpdir(), "harness-merge-"));
    const config: HarnessConfig = {
      version: 1,
      orchestratorMarker: "harness-orchestrator-v1",
      logDirectory: tempRoot,
      defaultModel: { id: "composer-2.5" },
      linear: {
        teamKey: "WES",
        eligibleStatuses: { merge: ["Ready to Merge"] },
        transitionalStatuses: {
          readyToMerge: "Ready to Merge",
          mergingInProgress: "Merging",
          mergedDeployed: "Merged / Deployed",
          blocked: "Blocked",
        },
      },
      merge: {
        mergeMethod: "squash",
        allowUnknownChecks: true,
      },
      repos: [
        {
          id: "target-app",
          linearProjects: ["Example Target App"],
          targetRepo: "https://github.com/owner/example-target-app",
          baseBranch: "main",
          previewProvider: "vercel",
          productionUrl: "https://www.example.com",
        },
      ],
      allowedTargetRepos: [
        "https://github.com/owner/example-target-app",
      ],
    };
    configPath = path.join(tempRoot, "harness.config.json");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");

    mocks.createLinearClient.mockReturnValue({});
    mocks.listIssueComments.mockResolvedValue([
      { id: "rev-1", body: revisionCommentBody, createdAt: "2026-07-07T05:38:00.000Z" },
    ]);
    mocks.transitionIssueStatus.mockResolvedValue(undefined);
    mocks.postMergeCompletionComment.mockResolvedValue("merge-comment-1");
    mocks.postPhaseStartCommentIfNeeded.mockResolvedValue("merge-start-1");
    mocks.inspectPullRequestForMerge.mockResolvedValue({
      title: "[WES-13] test",
      url: "https://github.com/owner/example-target-app/pull/4",
      branch: "cursor/wes-13-test",
      baseBranch: "main",
      state: "open",
      merged: false,
      isDraft: false,
      mergeCommitSha: null,
      mergedAt: null,
      repoUrl: "https://github.com/owner/example-target-app",
      changedFiles: [{ path: "app/hello-world/page.tsx", status: "modified" }],
      checks: [{ name: "CI", status: "completed", conclusion: "success", detailsUrl: null }],
      checkSummary: "- Passed: 1",
      comments: [],
      rawChecks: [],
    });
    mocks.mergePullRequest.mockResolvedValue({
      sha: "merged-sha-123",
      merged: true,
    });
    mocks.inspectPullRequestPostMerge.mockResolvedValue({
      title: "[WES-13] test",
      url: "https://github.com/owner/example-target-app/pull/4",
      branch: "cursor/wes-13-test",
      baseBranch: "main",
      state: "closed",
      merged: true,
      isDraft: false,
      mergeCommitSha: "merged-sha-123",
      mergedAt: "2026-07-07T06:00:00.000Z",
      repoUrl: "https://github.com/owner/example-target-app",
      changedFiles: [{ path: "app/hello-world/page.tsx", status: "modified" }],
      checks: [],
      checkSummary: "- Passed: 1",
      comments: [],
      rawChecks: [],
    });
    mocks.pollForProductionDeployment.mockResolvedValue({
      deploymentUrl: "https://www.example.com",
      source: "config_reference",
      polledSeconds: 0,
      warnings: [],
    });
    mocks.fetchLinearIssue.mockResolvedValue({
      id: "issue-1",
      identifier: "WES-13",
      status: "Merged / Deployed",
      teamId: "team-1",
      description: issueDescription,
      projectName: "Example Target App",
      teamName: "Weston Product Lab",
    });
  });

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  it("merges PR and transitions to Merged / Deployed", async () => {
    mocks.fetchLinearIssue
      .mockResolvedValueOnce({
        id: "issue-1",
        identifier: "WES-13",
        status: "Ready to Merge",
        teamId: "team-1",
        description: issueDescription,
        projectName: "Example Target App",
        teamName: "Weston Product Lab",
      })
      .mockResolvedValueOnce({
        id: "issue-1",
        identifier: "WES-13",
        status: "Merged / Deployed",
        teamId: "team-1",
        description: issueDescription,
        projectName: "Example Target App",
        teamName: "Weston Product Lab",
      });

    const result = await executeMergePhase({
      issueKey: "WES-13",
      configPath,
    });

    expect(result.exitCode).toBe(0);
    expect(result.manifest.finalOutcome).toBe("success");
    expect(result.manifest.phase).toBe("merge");
    expect(result.manifest.mergeCommitSha).toBe("merged-sha-123");
    expect(result.manifest.linearStatusAfter).toBe("Merged / Deployed");
    expect(mocks.mergePullRequest).toHaveBeenCalled();
    expect(mocks.postMergeCompletionComment).toHaveBeenCalled();
    expect(mocks.transitionIssueStatus).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ identifier: "WES-13" }),
      "Merging",
    );
  });

  it("transitions to Merging and posts start comment before PR inspect and merge", async () => {
    const callOrder: string[] = [];

    mocks.transitionIssueStatus.mockImplementation(async () => {
      callOrder.push("status");
    });
    mocks.postPhaseStartCommentIfNeeded.mockImplementation(async () => {
      callOrder.push("startComment");
      return "merge-start-1";
    });
    mocks.inspectPullRequestForMerge.mockImplementation(async () => {
      callOrder.push("inspect");
      return {
        title: "[WES-13] test",
        url: "https://github.com/owner/example-target-app/pull/4",
        branch: "cursor/wes-13-test",
        baseBranch: "main",
        state: "open",
        merged: false,
        isDraft: false,
        mergeCommitSha: null,
        mergedAt: null,
        repoUrl: "https://github.com/owner/example-target-app",
        changedFiles: [{ path: "app/hello-world/page.tsx", status: "modified" }],
        checks: [{ name: "CI", status: "completed", conclusion: "success", detailsUrl: null }],
        checkSummary: "- Passed: 1",
        comments: [],
        rawChecks: [],
      };
    });
    mocks.mergePullRequest.mockImplementation(async () => {
      callOrder.push("merge");
      return { sha: "merged-sha-123", merged: true };
    });
    mocks.postMergeCompletionComment.mockImplementation(async () => {
      callOrder.push("completeComment");
      return "merge-comment-1";
    });

    mocks.fetchLinearIssue
      .mockResolvedValueOnce({
        id: "issue-1",
        identifier: "WES-13",
        status: "Ready to Merge",
        teamId: "team-1",
        description: issueDescription,
        projectName: "Example Target App",
        teamName: "Weston Product Lab",
      })
      .mockResolvedValueOnce({
        id: "issue-1",
        identifier: "WES-13",
        status: "Merged / Deployed",
        teamId: "team-1",
        description: issueDescription,
        projectName: "Example Target App",
        teamName: "Weston Product Lab",
      });

    await executeMergePhase({
      issueKey: "WES-13",
      configPath,
    });

    expect(callOrder.indexOf("status")).toBeLessThan(callOrder.indexOf("inspect"));
    expect(callOrder.indexOf("startComment")).toBeLessThan(callOrder.indexOf("inspect"));
    expect(callOrder.indexOf("inspect")).toBeLessThan(callOrder.indexOf("merge"));
    expect(callOrder.indexOf("merge")).toBeLessThan(callOrder.indexOf("completeComment"));
  });

  it("marks draft PR ready before merge", async () => {
    mocks.inspectPullRequestForMerge
      .mockResolvedValueOnce({
        title: "[WES-13] test",
        url: "https://github.com/owner/example-target-app/pull/4",
        branch: "cursor/wes-13-test",
        baseBranch: "main",
        state: "open",
        merged: false,
        isDraft: true,
        mergeCommitSha: null,
        mergedAt: null,
        repoUrl: "https://github.com/owner/example-target-app",
        changedFiles: [{ path: "app/hello-world/page.tsx", status: "modified" }],
        checks: [{ name: "CI", status: "completed", conclusion: "success", detailsUrl: null }],
        checkSummary: "- Passed: 1",
        comments: [],
        rawChecks: [],
      })
      .mockResolvedValueOnce({
        title: "[WES-13] test",
        url: "https://github.com/owner/example-target-app/pull/4",
        branch: "cursor/wes-13-test",
        baseBranch: "main",
        state: "open",
        merged: false,
        isDraft: false,
        mergeCommitSha: null,
        mergedAt: null,
        repoUrl: "https://github.com/owner/example-target-app",
        changedFiles: [{ path: "app/hello-world/page.tsx", status: "modified" }],
        checks: [{ name: "CI", status: "completed", conclusion: "success", detailsUrl: null }],
        checkSummary: "- Passed: 1",
        comments: [],
        rawChecks: [],
      });
    mocks.markPullRequestReadyForReview.mockResolvedValue({ draft: true });
    mocks.fetchLinearIssue
      .mockResolvedValueOnce({
        id: "issue-1",
        identifier: "WES-13",
        status: "Ready to Merge",
        teamId: "team-1",
        description: issueDescription,
        projectName: "Example Target App",
        teamName: "Weston Product Lab",
      })
      .mockResolvedValueOnce({
        id: "issue-1",
        identifier: "WES-13",
        status: "Merged / Deployed",
        teamId: "team-1",
        description: issueDescription,
        projectName: "Example Target App",
        teamName: "Weston Product Lab",
      });

    const result = await executeMergePhase({
      issueKey: "WES-13",
      configPath,
    });

    expect(result.exitCode).toBe(0);
    expect(mocks.markPullRequestReadyForReview).toHaveBeenCalledWith(
      "owner",
      "example-target-app",
      4,
    );
    expect(mocks.mergePullRequest).toHaveBeenCalled();
  });

  it("polls until draft clears when mark-ready response still shows draft", async () => {
    mocks.inspectPullRequestForMerge
      .mockResolvedValueOnce({
        title: "[WES-13] test",
        url: "https://github.com/owner/example-target-app/pull/4",
        branch: "cursor/wes-13-test",
        baseBranch: "main",
        state: "open",
        merged: false,
        isDraft: true,
        mergeCommitSha: null,
        mergedAt: null,
        repoUrl: "https://github.com/owner/example-target-app",
        changedFiles: [{ path: "app/hello-world/page.tsx", status: "modified" }],
        checks: [{ name: "CI", status: "completed", conclusion: "success", detailsUrl: null }],
        checkSummary: "- Passed: 1",
        comments: [],
        rawChecks: [],
      })
      .mockResolvedValueOnce({
        title: "[WES-13] test",
        url: "https://github.com/owner/example-target-app/pull/4",
        branch: "cursor/wes-13-test",
        baseBranch: "main",
        state: "open",
        merged: false,
        isDraft: true,
        mergeCommitSha: null,
        mergedAt: null,
        repoUrl: "https://github.com/owner/example-target-app",
        changedFiles: [{ path: "app/hello-world/page.tsx", status: "modified" }],
        checks: [{ name: "CI", status: "completed", conclusion: "success", detailsUrl: null }],
        checkSummary: "- Passed: 1",
        comments: [],
        rawChecks: [],
      })
      .mockResolvedValueOnce({
        title: "[WES-13] test",
        url: "https://github.com/owner/example-target-app/pull/4",
        branch: "cursor/wes-13-test",
        baseBranch: "main",
        state: "open",
        merged: false,
        isDraft: false,
        mergeCommitSha: null,
        mergedAt: null,
        repoUrl: "https://github.com/owner/example-target-app",
        changedFiles: [{ path: "app/hello-world/page.tsx", status: "modified" }],
        checks: [{ name: "CI", status: "completed", conclusion: "success", detailsUrl: null }],
        checkSummary: "- Passed: 1",
        comments: [],
        rawChecks: [],
      });
    mocks.markPullRequestReadyForReview.mockResolvedValue({ draft: true });
    mocks.fetchLinearIssue
      .mockResolvedValueOnce({
        id: "issue-1",
        identifier: "WES-13",
        status: "Ready to Merge",
        teamId: "team-1",
        description: issueDescription,
        projectName: "Example Target App",
        teamName: "Weston Product Lab",
      })
      .mockResolvedValueOnce({
        id: "issue-1",
        identifier: "WES-13",
        status: "Merged / Deployed",
        teamId: "team-1",
        description: issueDescription,
        projectName: "Example Target App",
        teamName: "Weston Product Lab",
      });

    const result = await executeMergePhase({
      issueKey: "WES-13",
      configPath,
    });

    expect(result.exitCode).toBe(0);
    expect(mocks.inspectPullRequestForMerge).toHaveBeenCalledTimes(4);
    expect(mocks.mergePullRequest).toHaveBeenCalled();
  });

  it("transitions to Merged to Dev for integration merge and skips production poll", async () => {
    const { writeFile } = await import("node:fs/promises");
    const devConfig: HarnessConfig = {
      version: 1,
      orchestratorMarker: "harness-orchestrator-v1",
      logDirectory: tempRoot,
      defaultModel: { id: "composer-2.5" },
      linear: {
        teamKey: "WES",
        eligibleStatuses: { merge: ["Ready to Merge"] },
        transitionalStatuses: {
          readyToMerge: "Ready to Merge",
          mergingInProgress: "Merging",
          mergedToDev: "Merged to Dev",
          mergedDeployed: "Merged / Deployed",
          blocked: "Blocked",
        },
      },
      merge: { mergeMethod: "squash", allowUnknownChecks: true },
      repos: [
        {
          id: "target-app",
          linearProjects: ["Example Target App"],
          targetRepo: "https://github.com/owner/example-target-app",
          baseBranch: "dev",
          productionBranch: "main",
          integrationPreviewUrl: "https://dev.example.vercel.app",
        },
      ],
      allowedTargetRepos: [
        "https://github.com/owner/example-target-app",
      ],
    };
    await writeFile(configPath, `${JSON.stringify(devConfig, null, 2)}\n`, "utf8");

    mocks.inspectPullRequestForMerge.mockResolvedValue({
      title: "[WES-13] test",
      url: "https://github.com/owner/example-target-app/pull/4",
      branch: "cursor/wes-13-test",
      baseBranch: "dev",
      state: "open",
      merged: false,
      isDraft: false,
      mergeCommitSha: null,
      mergedAt: null,
      repoUrl: "https://github.com/owner/example-target-app",
      changedFiles: [{ path: "app/hello-world/page.tsx", status: "modified" }],
      checks: [{ name: "CI", status: "completed", conclusion: "success", detailsUrl: null }],
      checkSummary: "- Passed: 1",
      comments: [],
      rawChecks: [],
    });
    mocks.inspectPullRequestPostMerge.mockResolvedValue({
      title: "[WES-13] test",
      url: "https://github.com/owner/example-target-app/pull/4",
      branch: "cursor/wes-13-test",
      baseBranch: "dev",
      state: "closed",
      merged: true,
      mergeCommitSha: "merged-sha-dev",
      mergedAt: "2026-07-07T06:00:00.000Z",
      repoUrl: "https://github.com/owner/example-target-app",
      changedFiles: [{ path: "app/hello-world/page.tsx", status: "modified" }],
      checks: [],
      checkSummary: "- Passed: 1",
      comments: [],
      rawChecks: [],
    });
    mocks.fetchLinearIssue
      .mockResolvedValueOnce({
        id: "issue-1",
        identifier: "WES-13",
        status: "Ready to Merge",
        teamId: "team-1",
        description: issueDescription,
        projectName: "Example Target App",
        teamName: "Weston Product Lab",
      })
      .mockResolvedValueOnce({
        id: "issue-1",
        identifier: "WES-13",
        status: "Merged to Dev",
        teamId: "team-1",
        description: issueDescription,
        projectName: "Example Target App",
        teamName: "Weston Product Lab",
      });

    const result = await executeMergePhase({
      issueKey: "WES-13",
      configPath,
    });

    expect(result.exitCode).toBe(0);
    expect(result.manifest.linearStatusAfter).toBe("Merged to Dev");
    expect(mocks.pollForProductionDeployment).not.toHaveBeenCalled();
    expect(mocks.transitionIssueStatus).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ identifier: "WES-13" }),
      "Merged to Dev",
    );
  });

  it("fails with wrong_pr_base_branch when PR targets unexpected base", async () => {
    mocks.inspectPullRequestForMerge.mockResolvedValue({
      title: "[WES-13] test",
      url: "https://github.com/owner/example-target-app/pull/4",
      branch: "cursor/wes-13-test",
      baseBranch: "dev",
      state: "open",
      merged: false,
      isDraft: false,
      mergeCommitSha: null,
      mergedAt: null,
      repoUrl: "https://github.com/owner/example-target-app",
      changedFiles: [],
      checks: [],
      checkSummary: "- Passed: 0",
      comments: [],
      rawChecks: [],
    });
    mocks.fetchLinearIssue.mockResolvedValueOnce({
      id: "issue-1",
      identifier: "WES-13",
      status: "Ready to Merge",
      teamId: "team-1",
      description: issueDescription,
      projectName: "Example Target App",
      teamName: "Weston Product Lab",
    });

    const result = await executeMergePhase({
      issueKey: "WES-13",
      configPath,
    });

    expect(result.exitCode).toBe(2);
    expect(result.manifest.errorClassification).toBe("wrong_pr_base_branch");
    expect(mocks.mergePullRequest).not.toHaveBeenCalled();
  });

  it("repairs and merges when PR is dirty after waiting in merge queue", async () => {
    mocks.inspectPullRequestForMerge.mockResolvedValue({
      title: "[WES-13] test",
      url: "https://github.com/owner/example-target-app/pull/4",
      branch: "cursor/wes-13-test",
      headSha: "dirty-sha",
      baseBranch: "main",
      state: "open",
      merged: false,
      isDraft: false,
      mergeable: false,
      mergeableState: "dirty",
      rebaseable: false,
      mergeCommitSha: null,
      mergedAt: null,
      repoUrl: "https://github.com/owner/example-target-app",
      changedFiles: [{ path: "app/hello-world/page.tsx", status: "modified" }],
      checks: [{ name: "CI", status: "completed", conclusion: "success", detailsUrl: null }],
      checkSummary: "- Passed: 1",
      comments: [],
      rawChecks: [],
    });
    mocks.attemptIntegrationRepair.mockResolvedValue({
      inspection: {
        title: "[WES-13] test",
        url: "https://github.com/owner/example-target-app/pull/4",
        branch: "cursor/wes-13-test",
        headSha: "repaired-sha",
        baseBranch: "main",
        state: "open",
        merged: false,
        isDraft: false,
        mergeable: true,
        mergeableState: "clean",
        rebaseable: true,
        mergeCommitSha: null,
        mergedAt: null,
        repoUrl: "https://github.com/owner/example-target-app",
        changedFiles: [{ path: "app/hello-world/page.tsx", status: "modified" }],
        checks: [{ name: "CI", status: "completed", conclusion: "success", detailsUrl: null }],
        checkSummary: "- Passed: 1",
        comments: [],
        rawChecks: [],
      },
      validationSummary: "Integration repair passed",
    });
    mocks.fetchLinearIssue.mockResolvedValueOnce({
      id: "issue-1",
      identifier: "WES-13",
      status: "Ready to Merge",
      teamId: "team-1",
      description: issueDescription,
      projectName: "Example Target App",
      teamName: "Weston Product Lab",
    });

    const result = await executeMergePhase({
      issueKey: "WES-13",
      configPath,
    });

    expect(result.exitCode).toBe(0);
    expect(result.manifest.finalOutcome).toBe("success");
    expect(mocks.attemptIntegrationRepair).toHaveBeenCalledTimes(1);
    expect(mocks.mergePullRequest).toHaveBeenCalledTimes(1);
  });

  it("no-ops duplicate merge when marker exists and PR is already merged", async () => {
    const mergeCompletionBody = `## Merge complete
---
harness-orchestrator-v1
phase: merge
run_id: prior-merge-run
model: composer-2.5
prompt_version: merge@1
target_repo: https://github.com/owner/example-target-app
pr_url: https://github.com/owner/example-target-app/pull/4
merge_commit_sha: merged-sha-123
---`;

    mocks.listIssueComments.mockResolvedValue([
      { id: "rev-1", body: revisionCommentBody, createdAt: "2026-07-07T05:38:00.000Z" },
      { id: "merge-1", body: mergeCompletionBody, createdAt: "2026-07-07T06:00:00.000Z" },
    ]);
    mocks.inspectPullRequestForMerge.mockResolvedValue({
      title: "[WES-13] test",
      url: "https://github.com/owner/example-target-app/pull/4",
      branch: "cursor/wes-13-test",
      baseBranch: "main",
      state: "closed",
      merged: true,
      isDraft: false,
      mergeable: null,
      mergeableState: null,
      rebaseable: null,
      mergeCommitSha: "merged-sha-123",
      mergedAt: "2026-07-07T06:00:00.000Z",
      repoUrl: "https://github.com/owner/example-target-app",
      changedFiles: [{ path: "app/hello-world/page.tsx", status: "modified" }],
      checks: [],
      checkSummary: "- Passed: 1",
      comments: [],
      rawChecks: [],
    });
    mocks.fetchLinearIssue.mockResolvedValueOnce({
      id: "issue-1",
      identifier: "WES-13",
      status: "Ready to Merge",
      teamId: "team-1",
      description: issueDescription,
      projectName: "Example Target App",
      teamName: "Weston Product Lab",
    });

    const result = await executeMergePhase({
      issueKey: "WES-13",
      configPath,
    });

    expect(result.exitCode).toBe(0);
    expect(result.manifest.finalOutcome).toBe("duplicate");
    expect(result.manifest.errorClassification).toBe("duplicate_phase_completed");
    expect(mocks.mergePullRequest).not.toHaveBeenCalled();
  });

  it("skips production deployment polling when previewProvider is none", async () => {
    const config: HarnessConfig = {
      version: 1,
      orchestratorMarker: "harness-orchestrator-v1",
      logDirectory: tempRoot,
      defaultModel: { id: "composer-2.5" },
      linear: {
        teamKey: "WES",
        eligibleStatuses: { merge: ["Ready to Merge"] },
        transitionalStatuses: {
          readyToMerge: "Ready to Merge",
          mergingInProgress: "Merging",
          mergedDeployed: "Merged / Deployed",
          blocked: "Blocked",
        },
      },
      merge: {
        mergeMethod: "squash",
        allowUnknownChecks: true,
      },
      repos: [
        {
          id: "target-app",
          linearProjects: ["Example Target App"],
          targetRepo: "https://github.com/owner/example-target-app",
          baseBranch: "main",
          previewProvider: "none",
          productionUrl: "https://www.example.com",
        },
      ],
      allowedTargetRepos: [
        "https://github.com/owner/example-target-app",
      ],
    };
    const noneConfigPath = path.join(tempRoot, "harness.none.config.json");
    await import("node:fs/promises").then((fs) =>
      fs.writeFile(noneConfigPath, JSON.stringify(config), "utf8"),
    );

    mocks.fetchLinearIssue
      .mockReset()
      .mockResolvedValueOnce({
        id: "issue-1",
        identifier: "WES-13",
        status: "Ready to Merge",
        teamId: "team-1",
        description: issueDescription,
        projectName: "Example Target App",
        teamName: "Weston Product Lab",
      })
      .mockResolvedValueOnce({
        id: "issue-1",
        identifier: "WES-13",
        status: "Merged / Deployed",
        teamId: "team-1",
        description: issueDescription,
        projectName: "Example Target App",
        teamName: "Weston Product Lab",
      });

    const result = await executeMergePhase({
      issueKey: "WES-13",
      configPath: noneConfigPath,
    });

    expect(result.exitCode).toBe(0);
    expect(result.manifest.finalOutcome).toBe("success");
    expect(mocks.pollForProductionDeployment).not.toHaveBeenCalled();
  });
});
