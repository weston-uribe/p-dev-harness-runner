import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  transitionIssueStatus: vi.fn(),
  postHandoffComment: vi.fn(),
  postErrorComment: vi.fn(),
  listIssueComments: vi.fn(),
  createLinearClient: vi.fn(),
  fetchLinearIssue: vi.fn(),
  inspectPullRequest: vi.fn(),
  pollForVercelPreview: vi.fn(),
}));

vi.mock("../../src/linear/writer.js", () => ({
  transitionIssueStatus: mocks.transitionIssueStatus,
  postHandoffComment: mocks.postHandoffComment,
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
    inspectPullRequest: mocks.inspectPullRequest,
  };
});

vi.mock("../../src/preview/vercel-from-pr.js", () => ({
  pollForVercelPreview: mocks.pollForVercelPreview,
}));

vi.mock("../../src/product/read-product-marker.js", () => ({
  readProductMarker: vi.fn().mockResolvedValue({
    content: null,
    markerPath: ".p-dev/product.json",
    developmentBranch: "dev",
  }),
}));

vi.mock("../../src/github/pr-discovery.js", () => ({
  findImplementationPullRequest: vi.fn().mockResolvedValue({
    prUrl: "https://github.com/owner/example-target-app/pull/4",
    prNumber: 4,
    branch: "cursor/wes-13-test",
    headSha: "abc123",
    baseBranch: "main",
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

import { executeHandoffPhase } from "../../src/runner/phases/handoff.js";
import type { HarnessConfig } from "../../src/config/types.js";

const issueDescription = `## Target repo

owner/example-target-app

## Task

Handoff test issue.

## Acceptance criteria

- [ ] PR is open

## Out of scope

- [ ] Merge

## Validation expectations

Run npm run lint and npm run build.`;

describe("executeHandoffPhase", () => {
  let tempRoot = "";
  let configPath = "";

  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.fetchLinearIssue.mockReset();
    tempRoot = await mkdtemp(path.join(tmpdir(), "harness-handoff-"));
    const config: HarnessConfig = {
      version: 1,
      orchestratorMarker: "harness-orchestrator-v1",
      logDirectory: tempRoot,
      defaultModel: { id: "composer-2.5" },
      linear: {
        teamKey: "WES",
        eligibleStatuses: {
          handoff: ["PR Open"],
        },
        transitionalStatuses: {
          prOpen: "PR Open",
          pmReview: "PM Review",
          blocked: "Blocked",
        },
      },
      handoff: { allowPmReviewWithoutPreview: true },
      preview: { pollTimeoutSeconds: 1, pollIntervalSeconds: 1 },
      repos: [
        {
          id: "target-app",
          linearProjects: ["Example Target App"],
          targetRepo: "https://github.com/owner/example-target-app",
          baseBranch: "main",
          previewProvider: "vercel",
          validation: { commands: ["npm run lint", "npm run build"] },
        },
      ],
      allowedTargetRepos: [
        "https://github.com/owner/example-target-app",
      ],
    };
    configPath = path.join(tempRoot, "harness.config.json");
    await import("node:fs/promises").then((fs) =>
      fs.writeFile(configPath, JSON.stringify(config), "utf8"),
    );

    process.env.LINEAR_API_KEY = "test-linear-key";
    process.env.GITHUB_TOKEN = "test-github-token";

    mocks.listIssueComments.mockResolvedValue([]);
    mocks.transitionIssueStatus.mockResolvedValue(undefined);
    mocks.postHandoffComment.mockResolvedValue("handoff-comment-1");
    mocks.postErrorComment.mockResolvedValue("error-comment-1");
    mocks.createLinearClient.mockReturnValue({});
    mocks.inspectPullRequest.mockResolvedValue({
      title: "M3 hello world",
      url: "https://github.com/owner/example-target-app/pull/4",
      branch: "cursor/wes-13-test",
      baseBranch: "main",
      state: "open",
      merged: false,
      repoUrl: "https://github.com/owner/example-target-app",
      headSha: "abc123def456",
      baseSha: "fedcba654321",
      changedFiles: [{ path: "src/app/hello/page.tsx", status: "added" }],
      checks: [],
      checkSummary: "No GitHub check runs reported for the PR head commit.",
      comments: [],
      rawChecks: null,
    });
    mocks.pollForVercelPreview.mockResolvedValue({
      previewUrl: "https://example.vercel.app",
      source: "vercel_comment",
      polledSeconds: 0,
      warnings: [],
    });
    mocks.fetchLinearIssue
      .mockResolvedValueOnce({
        id: "issue-handoff",
        identifier: "WES-13",
        title: "M3 implementation integration test",
        description: issueDescription,
        status: "PR Open",
        projectName: "Example Target App",
        teamName: "WES",
        teamKey: null,
        teamId: "team-1",
        url: "https://linear.app/example/issue/WES-13/test",
      })
      .mockResolvedValueOnce({
        id: "issue-handoff",
        identifier: "WES-13",
        title: "M3 implementation integration test",
        description: issueDescription,
        status: "PM Review",
        projectName: "Example Target App",
        teamName: "WES",
        teamKey: null,
        teamId: "team-1",
        url: "https://linear.app/example/issue/WES-13/test",
      });
  });

  afterEach(async () => {
    delete process.env.LINEAR_API_KEY;
    delete process.env.GITHUB_TOKEN;
    await rm(tempRoot, { recursive: true, force: true });
  });

  it("runs happy path with PM Review transition", async () => {
    const result = await executeHandoffPhase({
      issueKey: "WES-13",
      configPath,
    });

    expect(result.exitCode).toBe(0);
    expect(result.manifest.finalOutcome).toBe("success");
    expect(result.manifest.linearStatusBefore).toBe("PR Open");
    expect(result.manifest.linearStatusAfter).toBe("PM Review");
    expect(result.manifest.prUrl).toContain("/pull/4");
    expect(result.manifest.previewUrl).toBe("https://example.vercel.app");
    expect(result.manifest.changedFiles).toContain("src/app/hello/page.tsx");
    expect(mocks.transitionIssueStatus).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      "PM Review",
    );
    expect(mocks.postHandoffComment).toHaveBeenCalledTimes(1);
  });

  it("fails before Linear writes when GITHUB_TOKEN is missing", async () => {
    delete process.env.GITHUB_TOKEN;

    const result = await executeHandoffPhase({
      issueKey: "WES-13",
      configPath,
    });

    expect(result.exitCode).toBe(2);
    expect(result.manifest.errorClassification).toBe("github_auth_failure");
    expect(mocks.postHandoffComment).not.toHaveBeenCalled();
    expect(mocks.transitionIssueStatus).not.toHaveBeenCalled();
  });

  it("moves to Blocked after failure once handoff was entered", async () => {
    mocks.inspectPullRequest.mockRejectedValue(
      new Error("pr_closed: PR https://github.com/owner/example-target-app/pull/4 is not open"),
    );

    const result = await executeHandoffPhase({
      issueKey: "WES-13",
      configPath,
    });

    expect(result.exitCode).toBe(3);
    expect(result.manifest.finalOutcome).toBe("failed");
    expect(result.manifest.errorClassification).toBe("pr_closed");
    expect(result.manifest.linearStatusAfter).toBe("Blocked");
    expect(mocks.postErrorComment).toHaveBeenCalledTimes(1);
    expect(mocks.transitionIssueStatus).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      "Blocked",
    );
  });

  it("completes PM Review when preview is missing and fallback is enabled", async () => {
    mocks.pollForVercelPreview.mockResolvedValue({
      previewUrl: null,
      source: null,
      polledSeconds: 1,
      warnings: ["Preview not found within 1s"],
    });
    mocks.fetchLinearIssue
      .mockReset()
      .mockResolvedValueOnce({
        id: "issue-handoff",
        identifier: "WES-13",
        title: "M3 implementation integration test",
        description: issueDescription,
        status: "PR Open",
        projectName: "Example Target App",
        teamName: "WES",
        teamKey: null,
        teamId: "team-1",
        url: "https://linear.app/example/issue/WES-13/test",
      })
      .mockResolvedValueOnce({
        id: "issue-handoff",
        identifier: "WES-13",
        title: "M3 implementation integration test",
        description: issueDescription,
        status: "PM Review",
        projectName: "Example Target App",
        teamName: "WES",
        teamKey: null,
        teamId: "team-1",
        url: "https://linear.app/example/issue/WES-13/test",
      });

    const result = await executeHandoffPhase({
      issueKey: "WES-13",
      configPath,
    });

    expect(result.exitCode).toBe(0);
    expect(result.manifest.finalOutcome).toBe("success");
    expect(result.manifest.previewUrl).toBeNull();
    expect(result.manifest.linearStatusAfter).toBe("PM Review");
    expect(mocks.postHandoffComment).toHaveBeenCalledTimes(1);
    const handoffBody = mocks.postHandoffComment.mock.calls[0]?.[2] as string;
    expect(handoffBody).toContain("Preview not found");
  });

  it("skips duplicate handoff when marker already exists", async () => {
    mocks.listIssueComments.mockResolvedValue([
      {
        id: "handoff-1",
        body: `## PM handoff\n\n<!--\nharness-orchestrator-v1\nphase: handoff\nrun_id: prior-run\npr_url: https://github.com/owner/example-target-app/pull/4\n-->`,
      },
    ]);
    // Legacy marker without subject identity only suppresses when already in PM Review.
    mocks.fetchLinearIssue.mockReset();
    mocks.fetchLinearIssue.mockResolvedValue({
      id: "issue-handoff",
      identifier: "WES-13",
      title: "M3 implementation integration test",
      description: issueDescription,
      status: "PM Review",
      projectName: "Example Target App",
      teamName: "WES",
      teamKey: null,
      teamId: "team-1",
      url: "https://linear.app/example/issue/WES-13/test",
    });

    const result = await executeHandoffPhase({
      issueKey: "WES-13",
      configPath,
    });

    expect(result.exitCode).toBe(0);
    expect(result.manifest.finalOutcome).toBe("duplicate");
    expect(mocks.postHandoffComment).not.toHaveBeenCalled();
    expect(mocks.transitionIssueStatus).not.toHaveBeenCalled();
  });

  it("skips preview polling when previewProvider is none", async () => {
    const config: HarnessConfig = {
      version: 1,
      orchestratorMarker: "harness-orchestrator-v1",
      logDirectory: tempRoot,
      defaultModel: { id: "composer-2.5" },
      linear: {
        teamKey: "WES",
        eligibleStatuses: {
          handoff: ["PR Open"],
        },
        transitionalStatuses: {
          prOpen: "PR Open",
          pmReview: "PM Review",
          blocked: "Blocked",
        },
      },
      handoff: { allowPmReviewWithoutPreview: false },
      repos: [
        {
          id: "target-app",
          linearProjects: ["Example Target App"],
          targetRepo: "https://github.com/owner/example-target-app",
          baseBranch: "main",
          previewProvider: "none",
          validation: { commands: ["npm run lint", "npm run build"] },
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

    const result = await executeHandoffPhase({
      issueKey: "WES-13",
      configPath: noneConfigPath,
    });

    expect(result.exitCode).toBe(0);
    expect(result.manifest.finalOutcome).toBe("success");
    expect(result.manifest.previewUrl).toBeNull();
    expect(mocks.pollForVercelPreview).not.toHaveBeenCalled();
    expect(mocks.transitionIssueStatus).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      "PM Review",
    );
  });
});
