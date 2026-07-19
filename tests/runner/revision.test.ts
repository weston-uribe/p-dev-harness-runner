import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  transitionIssueStatus: vi.fn(),
  postRevisionComment: vi.fn(),
  postPhaseStartCommentIfNeeded: vi.fn(),
  postErrorComment: vi.fn(),
  listIssueComments: vi.fn(),
  createLinearClient: vi.fn(),
  acquireBuilderAgent: vi.fn(),
  disposeAgent: vi.fn(),
  sendAndObserve: vi.fn(),
  fetchLinearIssue: vi.fn(),
  inspectPullRequest: vi.fn(),
  pollForVercelPreview: vi.fn(),
}));

vi.mock("../../src/linear/writer.js", () => ({
  transitionIssueStatus: mocks.transitionIssueStatus,
  postRevisionComment: mocks.postRevisionComment,
  postPhaseStartCommentIfNeeded: mocks.postPhaseStartCommentIfNeeded,
  postErrorComment: mocks.postErrorComment,
  listIssueComments: mocks.listIssueComments,
  createLinearClient: mocks.createLinearClient,
}));

vi.mock("../../src/agents/index.js", () => ({
  acquireBuilderAgent: mocks.acquireBuilderAgent,
  disposeAgent: mocks.disposeAgent,
  sendAndObserve: mocks.sendAndObserve,
  resolveModelId: vi.fn().mockReturnValue("composer-2.5"),
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

vi.mock("../../src/github/base-branch.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/github/base-branch.js")>();
  return {
    ...actual,
    assertBaseBranchExists: vi.fn().mockResolvedValue(undefined),
  };
});

import { executeRevisionPhase } from "../../src/runner/phases/revision.js";
import type { HarnessConfig } from "../../src/config/types.js";

const issueDescription = `## Target repo

owner/example-target-app

## Task

Revision test issue.

## Acceptance criteria

- [ ] PR is open

## Out of scope

- [ ] Merge

## Validation expectations

Run npm run lint and npm run build.`;

const handoffCommentBody = `## PM handoff

---
harness-orchestrator-v1
phase: handoff
run_id: 2026-07-07T05-00-00Z-WES-13
model: composer-2.5
prompt_version: handoff@1
target_repo: https://github.com/owner/example-target-app
branch: cursor/wes-13-test
pr_url: https://github.com/owner/example-target-app/pull/4
preview_url: https://example.vercel.app
---`;

const pmFeedbackBody =
  "Please change the Hello World page copy to say: Hello from the agentic harness.";

describe("executeRevisionPhase", () => {
  let tempRoot = "";
  let configPath = "";

  beforeEach(async () => {
    vi.clearAllMocks();
    tempRoot = await mkdtemp(path.join(tmpdir(), "harness-revision-"));
    const config: HarnessConfig = {
      version: 1,
      orchestratorMarker: "harness-orchestrator-v1",
      logDirectory: tempRoot,
      defaultModel: { id: "composer-2.5" },
      linear: {
        teamKey: "WES",
        eligibleStatuses: {
          revision: ["Needs Revision"],
        },
        transitionalStatuses: {
          needsRevision: "Needs Revision",
          revisingInProgress: "Revising",
          pmReview: "PM Review",
          blocked: "Blocked",
        },
      },
      revision: { timeoutSeconds: 60 },
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
    process.env.CURSOR_API_KEY = "test-cursor-key";
    process.env.GITHUB_TOKEN = "test-github-token";

    mocks.listIssueComments.mockResolvedValue([
      {
        id: "handoff-1",
        body: handoffCommentBody,
        createdAt: "2026-07-07T05:00:00.000Z",
      },
      {
        id: "pm-feedback-1",
        body: pmFeedbackBody,
        createdAt: "2026-07-07T05:01:00.000Z",
      },
    ]);
    mocks.transitionIssueStatus.mockResolvedValue(undefined);
    mocks.postRevisionComment.mockResolvedValue("revision-comment-1");
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
      changedFiles: [{ path: "app/hello-world/page.tsx", status: "modified" }],
      checks: [],
      checkSummary: "- Passed: 1",
      comments: [],
      rawChecks: null,
    });
    mocks.pollForVercelPreview.mockResolvedValue({
      previewUrl: "https://example.vercel.app",
      source: "vercel_comment",
      polledSeconds: 0,
      warnings: [],
    });
    mocks.acquireBuilderAgent.mockResolvedValue({
      agent: {
        agentId: "agent-rev",
        [Symbol.asyncDispose]: async () => undefined,
      },
      continuity: {
        action: "resumed",
        reference: {
          agentId: "agent-rev",
          generation: 1,
          originHarnessRunId: "impl-1",
          latestHarnessRunId: "run-rev",
          sourcePhase: "revision",
          targetRepo: "https://github.com/owner/example-target-app",
          branch: "cursor/wes-13-test",
          prUrl: "https://github.com/owner/example-target-app/pull/4",
        },
      },
    });
    mocks.sendAndObserve.mockResolvedValue({
      agentId: "agent-rev",
      runId: "run-rev",
      assistantText: "## Revision summary\n\nUpdated copy.",
      gitResult: {
        repoUrl: "https://github.com/owner/example-target-app",
        branch: "cursor/wes-13-test",
        prUrl: "https://github.com/owner/example-target-app/pull/4",
      },
      result: { id: "run-rev", status: "finished" },
      cancelOutcome: null,
    });
    mocks.fetchLinearIssue
      .mockResolvedValueOnce({
        id: "issue-rev",
        identifier: "WES-13",
        title: "M3 implementation integration test",
        description: issueDescription,
        status: "Needs Revision",
        projectName: "Example Target App",
        teamName: "WES",
        teamKey: null,
        teamId: "team-1",
        url: "https://linear.app/example/issue/WES-13/test",
      })
      .mockResolvedValueOnce({
        id: "issue-rev",
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
    delete process.env.CURSOR_API_KEY;
    delete process.env.GITHUB_TOKEN;
    await rm(tempRoot, { recursive: true, force: true });
  });

  it("runs happy path with Revising and PM Review transitions", async () => {
    const result = await executeRevisionPhase({
      issueKey: "WES-13",
      configPath,
    });

    expect(result.exitCode).toBe(0);
    expect(result.manifest.finalOutcome).toBe("success");
    expect(result.manifest.linearStatusBefore).toBe("Needs Revision");
    expect(result.manifest.linearStatusAfter).toBe("PM Review");
    expect(result.manifest.pmFeedbackCommentId).toBe("pm-feedback-1");
    expect(mocks.transitionIssueStatus).toHaveBeenCalledTimes(2);
    expect(mocks.postRevisionComment).toHaveBeenCalledTimes(1);
    expect(mocks.acquireBuilderAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        phase: "revision",
        context: expect.objectContaining({
          branch: "cursor/wes-13-test",
          prUrl: "https://github.com/owner/example-target-app/pull/4",
        }),
      }),
    );
    expect(result.manifest.builderAgentId).toBe("agent-rev");
    expect(result.manifest.builderThreadAction).toBe("resumed");
  });

  it("duplicate skips from PM Review when revision marker exists", async () => {
    mocks.listIssueComments.mockResolvedValue([
      {
        id: "handoff-1",
        body: handoffCommentBody,
        createdAt: "2026-07-07T05:00:00.000Z",
      },
      {
        id: "pm-feedback-1",
        body: pmFeedbackBody,
        createdAt: "2026-07-07T05:01:00.000Z",
      },
      {
        id: "rev-1",
        body: `## PM revision\n\n---\nharness-orchestrator-v1\nphase: revision\nrun_id: run-rev-old\npr_url: https://github.com/owner/example-target-app/pull/4\npm_feedback_comment_id: pm-feedback-1\n---`,
        createdAt: "2026-07-07T05:10:00.000Z",
      },
    ]);
    mocks.fetchLinearIssue.mockReset();
    mocks.fetchLinearIssue.mockResolvedValue({
      id: "issue-rev",
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

    const result = await executeRevisionPhase({
      issueKey: "WES-13",
      configPath,
    });

    expect(result.exitCode).toBe(0);
    expect(result.manifest.finalOutcome).toBe("duplicate");
    expect(mocks.postRevisionComment).not.toHaveBeenCalled();
    expect(mocks.acquireBuilderAgent).not.toHaveBeenCalled();
  });

  it("fails with wrong_status from PM Review without matching revision marker", async () => {
    mocks.fetchLinearIssue.mockReset();
    mocks.fetchLinearIssue.mockResolvedValue({
      id: "issue-rev",
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

    const result = await executeRevisionPhase({
      issueKey: "WES-13",
      configPath,
    });

    expect(result.exitCode).toBe(2);
    expect(result.manifest.errorClassification).toBe("wrong_status");
    expect(mocks.postRevisionComment).not.toHaveBeenCalled();
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
          revision: ["Needs Revision"],
        },
        transitionalStatuses: {
          needsRevision: "Needs Revision",
          revisingInProgress: "Revising",
          pmReview: "PM Review",
          blocked: "Blocked",
        },
      },
      revision: { timeoutSeconds: 60 },
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

    mocks.fetchLinearIssue
      .mockReset()
      .mockResolvedValueOnce({
        id: "issue-rev",
        identifier: "WES-13",
        title: "M3 implementation integration test",
        description: issueDescription,
        status: "Needs Revision",
        projectName: "Example Target App",
        teamName: "WES",
        teamKey: null,
        teamId: "team-1",
        url: "https://linear.app/example/issue/WES-13/test",
      })
      .mockResolvedValueOnce({
        id: "issue-rev",
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

    const result = await executeRevisionPhase({
      issueKey: "WES-13",
      configPath: noneConfigPath,
    });

    expect(result.exitCode).toBe(0);
    expect(result.manifest.finalOutcome).toBe("success");
    expect(mocks.pollForVercelPreview).not.toHaveBeenCalled();
    expect(mocks.postRevisionComment).toHaveBeenCalledTimes(1);
  });
});
