import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildMergeConcurrencyGroup,
  resolveRoute,
} from "../../src/runner/resolve-route.js";
import type { HarnessConfig } from "../../src/config/types.js";

const mocks = vi.hoisted(() => ({
  fetchLinearIssue: vi.fn(),
  listIssueComments: vi.fn(),
  findImplementationPullRequest: vi.fn(),
  getPullRequest: vi.fn(),
}));

vi.mock("../../src/linear/client.js", () => ({
  fetchLinearIssue: mocks.fetchLinearIssue,
}));

vi.mock("../../src/linear/writer.js", () => ({
  createLinearClient: vi.fn(() => ({})),
  listIssueComments: mocks.listIssueComments,
}));

vi.mock("../../src/github/pr-discovery.js", () => ({
  findImplementationPullRequest: mocks.findImplementationPullRequest,
}));

vi.mock("../../src/github/client.js", () => ({
  GitHubClient: class {
    getPullRequest = mocks.getPullRequest;
  },
}));

const targetAppConfig: HarnessConfig = {
  version: 1,
  orchestratorMarker: "harness-orchestrator-v1",
  logDirectory: "runs",
  linear: {
    teamKey: "WES",
    eligibleStatuses: {
      planning: ["Ready for Planning"],
      implementation: ["Ready for Build"],
      handoff: ["PR Open"],
      revision: ["Needs Revision"],
      merge: ["Ready to Merge"],
    },
  },
  repos: [
    {
      id: "target-app",
      linearProjects: ["Example Target App"],
      targetRepo: "https://github.com/owner/example-target-app",
      baseBranch: "dev",
      productionBranch: "main",
      previewProvider: "vercel",
    },
  ],
  allowedTargetRepos: ["https://github.com/owner/example-target-app"],
};

describe("buildMergeConcurrencyGroup", () => {
  it("builds repo and base branch slug", () => {
    expect(buildMergeConcurrencyGroup("target-app", "dev")).toBe("target-app-dev");
  });

  it("sanitizes branch characters", () => {
    expect(buildMergeConcurrencyGroup("target-app", "feature/foo")).toBe(
      "target-app-feature-foo",
    );
  });
});

describe("resolveRoute", () => {
  let tempRoot = "";
  let configPath = "";

  const previousConfigPath = process.env.HARNESS_CONFIG_PATH;
  const previousConfigJsonB64 = process.env.HARNESS_CONFIG_JSON_B64;
  const previousConfigJson = process.env.HARNESS_CONFIG_JSON;

  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.listIssueComments.mockResolvedValue([]);
    mocks.findImplementationPullRequest.mockResolvedValue(null);
    process.env.GITHUB_TOKEN = "test-github-token";
    process.env.LINEAR_API_KEY = "test-key";
    delete process.env.HARNESS_CONFIG_PATH;
    delete process.env.HARNESS_CONFIG_JSON_B64;
    delete process.env.HARNESS_CONFIG_JSON;
    tempRoot = await mkdtemp(path.join(tmpdir(), "harness-resolve-route-"));
    configPath = path.join(tempRoot, "harness.config.json");
    await writeFile(configPath, `${JSON.stringify(targetAppConfig, null, 2)}\n`, "utf8");
  });

  afterEach(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(tempRoot, { recursive: true, force: true });
    if (previousConfigPath === undefined) {
      delete process.env.HARNESS_CONFIG_PATH;
    } else {
      process.env.HARNESS_CONFIG_PATH = previousConfigPath;
    }
    if (previousConfigJsonB64 === undefined) {
      delete process.env.HARNESS_CONFIG_JSON_B64;
    } else {
      process.env.HARNESS_CONFIG_JSON_B64 = previousConfigJsonB64;
    }
    if (previousConfigJson === undefined) {
      delete process.env.HARNESS_CONFIG_JSON;
    } else {
      process.env.HARNESS_CONFIG_JSON = previousConfigJson;
    }
  });

  it("resolves merge phase and integration branch merge group", async () => {
    mocks.fetchLinearIssue.mockResolvedValue({
      id: "issue-1",
      identifier: "WES-21",
      title: "Merge test",
      description: `## Target repo\n\nowner/example-target-app\n\n## Task\n\nTest\n\n## Acceptance criteria\n\n- [ ] Done\n\n## Out of scope\n\n- [ ] N/A`,
      status: "Ready to Merge",
      projectName: "Example Target App",
      teamName: "WES",
      teamKey: null,
      teamId: "team-1",
      url: "https://linear.app/example/issue/WES-21",
    });
    mocks.listIssueComments.mockResolvedValue([
      {
        id: "rev-1",
        body: "---\nharness-orchestrator-v1\nphase: revision\nrun_id: run-rev\npm_feedback_comment_id: pm-1\npr_url: https://github.com/owner/example-target-app/pull/39\n---",
        createdAt: "2026-07-18T19:00:00.000Z",
      },
    ]);
    mocks.getPullRequest.mockResolvedValue({
      html_url: "https://github.com/owner/example-target-app/pull/39",
      state: "open",
      merged: false,
      merged_at: null,
      base: { ref: "dev" },
    });

    const result = await resolveRoute({
      issueKey: "WES-21",
      configPath,
      linearApiKey: "test-key",
    });

    expect(result.phase).toBe("merge");
    expect(result.repoConfigId).toBe("target-app");
    expect(result.baseBranch).toBe("dev");
    expect(result.mergeConcurrencyGroup).toBe("target-app-dev");
    expect(result.shouldRun).toBe(true);
    expect(result.reconcileReason).toBe("eligible_merge");
    expect(result.mergePrUrl).toBe(
      "https://github.com/owner/example-target-app/pull/39",
    );
  });

  it("short-circuits merge when merge-source marker is missing", async () => {
    mocks.fetchLinearIssue.mockResolvedValue({
      id: "issue-1",
      identifier: "WES-21",
      title: "Merge test",
      description: `## Target repo\n\nowner/example-target-app\n\n## Task\n\nTest\n\n## Acceptance criteria\n\n- [ ] Done\n\n## Out of scope\n\n- [ ] N/A`,
      status: "Ready to Merge",
      projectName: "Example Target App",
      teamName: "WES",
      teamKey: null,
      teamId: "team-1",
      url: "https://linear.app/example/issue/WES-21",
    });

    const result = await resolveRoute({
      issueKey: "WES-21",
      configPath,
      linearApiKey: "test-key",
    });

    expect(result.phase).toBe("merge");
    expect(result.shouldRun).toBe(false);
    expect(result.reconcileReason).toBe("missing_merge_source_marker");
  });

  it("honors explicit merge phase override with force while Merging", async () => {
    mocks.fetchLinearIssue.mockResolvedValue({
      id: "issue-1",
      identifier: "WES-21",
      title: "Recovery",
      description: `## Target repo\n\nowner/example-target-app\n\n## Task\n\nTest\n\n## Acceptance criteria\n\n- [ ] Done\n\n## Out of scope\n\n- [ ] N/A`,
      status: "Merging",
      projectName: "Example Target App",
      teamName: "WES",
      teamKey: null,
      teamId: "team-1",
      url: "https://linear.app/example/issue/WES-21",
    });
    mocks.listIssueComments.mockResolvedValue([
      {
        id: "rev-1",
        body: "---\nharness-orchestrator-v1\nphase: revision\nrun_id: run-rev\npm_feedback_comment_id: pm-1\npr_url: https://github.com/owner/example-target-app/pull/39\n---",
        createdAt: "2026-07-18T19:00:00.000Z",
      },
    ]);
    mocks.getPullRequest.mockResolvedValue({
      html_url: "https://github.com/owner/example-target-app/pull/39",
      state: "open",
      merged: false,
      merged_at: null,
      base: { ref: "dev" },
    });

    const result = await resolveRoute({
      issueKey: "WES-21",
      configPath,
      phase: "merge",
      linearApiKey: "test-key",
      force: true,
    });

    expect(result.phase).toBe("merge");
    expect(result.shouldRun).toBe(true);
  });

  it("routes Needs Revision issues to revision phase", async () => {
    mocks.fetchLinearIssue.mockResolvedValue({
      id: "issue-1",
      identifier: "WES-24",
      title: "Revision recovery",
      description: `## Target repo\n\nowner/example-target-app\n\n## Task\n\nTest\n\n## Acceptance criteria\n\n- [ ] Done\n\n## Out of scope\n\n- [ ] N/A`,
      status: "Needs Revision",
      projectName: "Example Target App",
      teamName: "WES",
      teamKey: null,
      teamId: "team-1",
      url: "https://linear.app/example/issue/WES-24",
    });

    mocks.listIssueComments.mockResolvedValue([
      {
        id: "handoff-1",
        body: "---\nharness-orchestrator-v1\nphase: handoff\nrun_id: run-handoff\npr_url: https://github.com/o/r/pull/4\n---",
        createdAt: "2026-07-18T18:15:00.000Z",
      },
      {
        id: "pm-1",
        body: "Please fix light mode contrast issues.",
        createdAt: "2026-07-18T18:25:00.000Z",
      },
    ]);

    const result = await resolveRoute({
      issueKey: "WES-24",
      configPath,
      linearApiKey: "test-key",
    });

    expect(result.phase).toBe("revision");
    expect(result.linearStatus).toBe("Needs Revision");
    expect(result.shouldRun).toBe(true);
    expect(result.pmFeedbackCommentId).toBe("pm-1");
    expect(result.reconcileReason).toBe("eligible_revision");
  });

  it("keeps Needs Revision pending when PM feedback is missing", async () => {
    mocks.fetchLinearIssue.mockResolvedValue({
      id: "issue-1",
      identifier: "WES-24",
      title: "Revision recovery",
      description: `## Target repo\n\nowner/example-target-app\n\n## Task\n\nTest\n\n## Acceptance criteria\n\n- [ ] Done\n\n## Out of scope\n\n- [ ] N/A`,
      status: "Needs Revision",
      projectName: "Example Target App",
      teamName: "WES",
      teamKey: null,
      teamId: "team-1",
      url: "https://linear.app/example/issue/WES-24",
    });
    mocks.listIssueComments.mockResolvedValue([
      {
        id: "handoff-1",
        body: "---\nharness-orchestrator-v1\nphase: handoff\nrun_id: run-handoff\npr_url: https://github.com/o/r/pull/4\n---",
        createdAt: "2026-07-18T18:15:00.000Z",
      },
    ]);

    const result = await resolveRoute({
      issueKey: "WES-24",
      configPath,
      linearApiKey: "test-key",
    });

    expect(result.phase).toBe("revision");
    expect(result.shouldRun).toBe(false);
    expect(result.reconcileReason).toBe("pending_pm_feedback");
  });

  it("routes Building issues with an open PR to handoff recovery", async () => {
    mocks.fetchLinearIssue.mockResolvedValue({
      id: "issue-1",
      identifier: "WES-22",
      title: "Recovery",
      description: `## Target repo\n\nowner/example-target-app\n\n## Task\n\nTest\n\n## Acceptance criteria\n\n- [ ] Done\n\n## Out of scope\n\n- [ ] N/A`,
      status: "Building",
      projectName: "Example Target App",
      teamName: "WES",
      teamKey: null,
      teamId: "team-1",
      url: "https://linear.app/example/issue/WES-22",
    });
    mocks.findImplementationPullRequest.mockResolvedValue({
      prUrl: "https://github.com/owner/example-target-app/pull/12",
      prNumber: 12,
      branch: "cursor/wes-22-test",
      headSha: "abc",
      baseBranch: "dev",
    });

    const result = await resolveRoute({
      issueKey: "WES-22",
      configPath,
      linearApiKey: "test-key",
    });

    expect(result.phase).toBe("handoff");
    expect(result.shouldRun).toBe(true);
  });

  it("suppresses duplicate Building implementation dispatches while fresh", async () => {
    const freshRunId = "2026-07-08T02-49-25-188Z-WES-22";
    vi.setSystemTime(new Date("2026-07-08T02:50:00.000Z"));

    mocks.fetchLinearIssue.mockResolvedValue({
      id: "issue-1",
      identifier: "WES-22",
      title: "In progress",
      description: `## Target repo\n\nowner/example-target-app\n\n## Task\n\nTest\n\n## Acceptance criteria\n\n- [ ] Done\n\n## Out of scope\n\n- [ ] N/A`,
      status: "Building",
      projectName: "Example Target App",
      teamName: "WES",
      teamKey: null,
      teamId: "team-1",
      url: "https://linear.app/example/issue/WES-22",
    });
    mocks.listIssueComments.mockResolvedValue([
      {
        id: "comment-1",
        body: `<!--\nharness-orchestrator-v1\nphase: implementation_start\nrun_id: ${freshRunId}\n-->`,
      },
    ]);

    const result = await resolveRoute({
      issueKey: "WES-22",
      configPath,
      linearApiKey: "test-key",
    });

    expect(result.phase).toBe("implementation");
    expect(result.shouldRun).toBe(false);

    vi.useRealTimers();
  });

  it("returns shouldRun false for ineligible status with auto phase", async () => {
    mocks.fetchLinearIssue.mockResolvedValue({
      id: "issue-1",
      identifier: "WES-21",
      title: "Idle",
      description: `## Target repo\n\nowner/example-target-app\n\n## Task\n\nTest\n\n## Acceptance criteria\n\n- [ ] Done\n\n## Out of scope\n\n- [ ] N/A`,
      status: "Backlog",
      projectName: "Example Target App",
      teamName: "WES",
      teamKey: null,
      teamId: "team-1",
      url: "https://linear.app/example/issue/WES-21",
    });

    const result = await resolveRoute({
      issueKey: "WES-21",
      configPath,
      linearApiKey: "test-key",
    });

    expect(result.phase).toBe("none");
    expect(result.shouldRun).toBe(false);
  });
});
