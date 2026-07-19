import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/workflow/canonical-workflow-gate.js", async (importOriginal) =>
  importOriginal<typeof import("../../src/workflow/canonical-workflow-gate.js")>(),
);

const mocks = vi.hoisted(() => ({
  transitionIssueStatus: vi.fn(),
  postPlanningComment: vi.fn(),
  postErrorComment: vi.fn(),
  postProductionSyncComment: vi.fn(),
  listIssueComments: vi.fn(),
  createLinearClient: vi.fn(),
  createPlanningAgent: vi.fn(),
  createImplementationAgent: vi.fn(),
  disposeAgent: vi.fn(),
  sendAndObserve: vi.fn(),
  fetchLinearIssue: vi.fn(),
  listTeamWorkflowStates: vi.fn(),
  createBranch: vi.fn(),
  createPullRequest: vi.fn(),
  mergePullRequest: vi.fn(),
}));

vi.mock("../../src/setup/linear-setup-client.js", () => ({
  createLinearSetupClient: vi.fn(() => ({})),
  listTeamWorkflowStates: mocks.listTeamWorkflowStates,
}));

vi.mock("../../src/linear/writer.js", () => ({
  transitionIssueStatus: mocks.transitionIssueStatus,
  postPlanningComment: mocks.postPlanningComment,
  postErrorComment: mocks.postErrorComment,
  postProductionSyncComment: mocks.postProductionSyncComment,
  listIssueComments: mocks.listIssueComments,
  createLinearClient: mocks.createLinearClient,
}));

vi.mock("../../src/agents/index.js", () => ({
  createPlanningAgent: mocks.createPlanningAgent,
  createImplementationAgent: mocks.createImplementationAgent,
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

vi.mock("../../src/github/client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/github/client.js")>();
  return {
    ...actual,
    GitHubClient: vi.fn().mockImplementation(() => ({
      createBranch: mocks.createBranch,
      createPullRequest: mocks.createPullRequest,
      mergePullRequest: mocks.mergePullRequest,
    })),
  };
});

import { executePlanningPhase } from "../../src/runner/phases/planning.js";
import { executeImplementationPhase } from "../../src/runner/phases/implementation.js";
import { executeMergePhase } from "../../src/runner/phases/merge.js";
import { executeProductionSyncForIssue } from "../../src/runner/phases/production-sync.js";
import { runPreflight } from "../../src/runner/preflight.js";
import type { HarnessConfig } from "../../src/config/types.js";

const VALID_WORKFLOW_STATES = [
  { id: "s-backlog", name: "Backlog", type: "backlog" },
  { id: "s-rfp", name: "Ready for Planning", type: "unstarted" },
  { id: "s-planning", name: "Planning", type: "started" },
  { id: "s-rfb", name: "Ready for Build", type: "unstarted" },
  { id: "s-building", name: "Building", type: "started" },
  { id: "s-pr", name: "PR Open", type: "started" },
  { id: "s-pm", name: "PM Review", type: "started" },
  { id: "s-eng", name: "Engineering Review", type: "started" },
  { id: "s-rev", name: "Needs Revision", type: "unstarted" },
  { id: "s-revising", name: "Revising", type: "started" },
  { id: "s-rtm", name: "Ready to Merge", type: "started" },
  { id: "s-merging", name: "Merging", type: "started" },
  { id: "s-mtd", name: "Merged to Dev", type: "completed" },
  { id: "s-deployed", name: "Merged / Deployed", type: "completed" },
  { id: "s-blocked", name: "Blocked", type: "started" },
  { id: "s-canceled", name: "Canceled", type: "canceled" },
];

const ISSUE_DESCRIPTION = `## Target repo

owner/example-target-app

## Task

Add hello page

## Acceptance criteria

- [ ] Route works

## Out of scope

- Harness`;

function buildConfig(tempRoot: string, overrides?: Partial<HarnessConfig>): HarnessConfig {
  return {
    version: 1,
    orchestratorMarker: "harness-orchestrator-v1",
    logDirectory: tempRoot,
    defaultModel: { id: "composer-2.5" },
    linear: {
      teamKey: "WES",
      teamId: "team-configured",
      eligibleStatuses: {
        planning: ["Ready for Planning"],
        implementation: ["Ready for Build"],
        handoff: ["PR Open"],
        revision: ["Needs Revision"],
        merge: ["Ready to Merge"],
      },
      transitionalStatuses: {
        planningInProgress: "Planning",
        buildingInProgress: "Building",
        prOpen: "PR Open",
        pmReview: "PM Review",
        blocked: "Blocked",
        readyForBuild: "Ready for Build",
        needsRevision: "Needs Revision",
        revisingInProgress: "Revising",
        readyToMerge: "Ready to Merge",
        mergingInProgress: "Merging",
        mergedToDev: "Merged to Dev",
        mergedDeployed: "Merged / Deployed",
      },
    },
    planning: { timeoutSeconds: 60 },
    implementation: { timeoutSeconds: 60, branchPrefix: "cursor/" },
    merge: { mergeMethod: "squash" },
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
    ...overrides,
  };
}

function expectNoSideEffects(): void {
  expect(mocks.createPlanningAgent).not.toHaveBeenCalled();
  expect(mocks.createImplementationAgent).not.toHaveBeenCalled();
  expect(mocks.sendAndObserve).not.toHaveBeenCalled();
  expect(mocks.postPlanningComment).not.toHaveBeenCalled();
  expect(mocks.postProductionSyncComment).not.toHaveBeenCalled();
  expect(mocks.transitionIssueStatus).not.toHaveBeenCalled();
  expect(mocks.createBranch).not.toHaveBeenCalled();
  expect(mocks.createPullRequest).not.toHaveBeenCalled();
  expect(mocks.mergePullRequest).not.toHaveBeenCalled();
}

describe("authoritative canonical workflow gate integration", () => {
  let tempRoot = "";
  let configPath = "";

  beforeEach(async () => {
    vi.clearAllMocks();
    tempRoot = await mkdtemp(path.join(tmpdir(), "harness-gate-"));
    const config = buildConfig(tempRoot);
    configPath = path.join(tempRoot, "harness.config.json");
    await writeFile(configPath, JSON.stringify(config), "utf8");

    process.env.LINEAR_API_KEY = "test-linear-key";
    process.env.CURSOR_API_KEY = "test-cursor-key";

    mocks.listTeamWorkflowStates.mockResolvedValue(VALID_WORKFLOW_STATES);
    mocks.listIssueComments.mockResolvedValue([]);
    mocks.createLinearClient.mockReturnValue({});
    mocks.fetchLinearIssue.mockResolvedValue({
      id: "issue-plan",
      identifier: "WES-PLAN",
      title: "Plan hello world",
      description: ISSUE_DESCRIPTION,
      status: "Ready for Planning",
      projectName: "Example Target App",
      teamName: "WES",
      teamKey: null,
      teamId: "team-configured",
      url: null,
    });
  });

  afterEach(async () => {
    delete process.env.LINEAR_API_KEY;
    delete process.env.CURSOR_API_KEY;
    delete process.env.GITHUB_TOKEN;
    await rm(tempRoot, { recursive: true, force: true });
  });

  it("blocks planning when LINEAR_API_KEY is missing", async () => {
    delete process.env.LINEAR_API_KEY;

    const result = await runPreflight({
      issueKey: "WES-PLAN",
      configPath,
    });

    expect(result.success).toBe(false);
    expect(result.errorClassification).toBe("linear_auth_failure");
    expectNoSideEffects();
  });

  it("blocks planning when issue teamId is missing", async () => {
    mocks.fetchLinearIssue.mockResolvedValueOnce({
      id: "issue-plan",
      identifier: "WES-PLAN",
      title: "Plan hello world",
      description: ISSUE_DESCRIPTION,
      status: "Ready for Planning",
      projectName: "Example Target App",
      teamName: "WES",
      teamKey: null,
      teamId: undefined,
      url: null,
    });

    const result = await runPreflight({
      issueKey: "WES-PLAN",
      configPath,
      linearApiKey: "test-linear-key",
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain("linear_team_identity_missing");
    expect(result.errorClassification).toBe("linear_team_identity_missing");
    expectNoSideEffects();
  });

  it("blocks planning when configured teamId is unresolved", async () => {
    const config = buildConfig(tempRoot, { linear: { teamKey: "WES" } });
    await writeFile(configPath, JSON.stringify(config), "utf8");

    const result = await executePlanningPhase({
      issueKey: "WES-PLAN",
      configPath,
    });

    expect(result.manifest.finalOutcome).toBe("failed");
    expect(result.manifest.errorClassification).toBe("linear_team_unresolved");
    expectNoSideEffects();
  });

  it("blocks planning when issue team mismatches configured team", async () => {
    mocks.fetchLinearIssue.mockResolvedValueOnce({
      id: "issue-plan",
      identifier: "WES-PLAN",
      title: "Plan hello world",
      description: ISSUE_DESCRIPTION,
      status: "Ready for Planning",
      projectName: "Example Target App",
      teamName: "WES",
      teamKey: null,
      teamId: "team-other",
      url: null,
    });

    const result = await executePlanningPhase({
      issueKey: "WES-PLAN",
      configPath,
    });

    expect(result.manifest.finalOutcome).toBe("failed");
    expect(result.manifest.errorClassification).toBe("linear_team_mismatch");
    expectNoSideEffects();
  });

  it("blocks planning when workflow state load fails", async () => {
    mocks.listTeamWorkflowStates.mockRejectedValueOnce(new Error("Linear API unavailable"));

    const result = await executePlanningPhase({
      issueKey: "WES-PLAN",
      configPath,
    });

    expect(result.manifest.finalOutcome).toBe("failed");
    expect(result.manifest.errorClassification).toBe("canonical_workflow_load_failed");
    expectNoSideEffects();
  });

  it("blocks planning when canonical workflow is invalid", async () => {
    mocks.listTeamWorkflowStates.mockReset();
    mocks.listTeamWorkflowStates.mockResolvedValue([
      { id: "s-backlog", name: "Backlog", type: "backlog" },
    ]);

    const result = await executePlanningPhase({
      issueKey: "WES-PLAN",
      configPath,
    });

    expect(result.manifest.finalOutcome).toBe("failed");
    expect(result.manifest.errorClassification).toBe("canonical_workflow_invalid");
    expectNoSideEffects();
  });

  it("blocks implementation when canonical workflow is invalid", async () => {
    mocks.fetchLinearIssue.mockResolvedValue({
      id: "issue-impl",
      identifier: "WES-IMPL",
      title: "Build hello world",
      description: ISSUE_DESCRIPTION,
      status: "Ready for Build",
      projectName: "Example Target App",
      teamName: "WES",
      teamKey: null,
      teamId: "team-configured",
      url: null,
    });
    mocks.listTeamWorkflowStates.mockReset();
    mocks.listTeamWorkflowStates.mockResolvedValue([
      { id: "s-backlog", name: "Backlog", type: "backlog" },
    ]);

    const result = await executeImplementationPhase({
      issueKey: "WES-IMPL",
      configPath,
    });

    expect(result.manifest.finalOutcome).toBe("failed");
    expect(result.manifest.errorClassification).toBe("canonical_workflow_invalid");
    expectNoSideEffects();
  });

  it("blocks production sync with canonical_workflow_invalid classification", async () => {
    process.env.GITHUB_TOKEN = "test-github-token";

    mocks.fetchLinearIssue.mockResolvedValue({
      id: "issue-sync",
      identifier: "WES-SYNC",
      title: "Sync",
      description: ISSUE_DESCRIPTION,
      status: "Merged to Dev",
      projectName: "Example Target App",
      teamName: "WES",
      teamKey: null,
      teamId: "team-configured",
      url: null,
    });
    mocks.listTeamWorkflowStates.mockReset();
    mocks.listTeamWorkflowStates.mockResolvedValue([
      { id: "s-backlog", name: "Backlog", type: "backlog" },
    ]);

    const result = await executeProductionSyncForIssue({
      issueKey: "WES-SYNC",
      configPath,
    });

    expect(result.manifest.finalOutcome).toBe("failed");
    expect(result.manifest.errorClassification).toBe("canonical_workflow_invalid");
    expect(mocks.listIssueComments).not.toHaveBeenCalled();
    expect(mocks.postProductionSyncComment).not.toHaveBeenCalled();
    expect(mocks.transitionIssueStatus).not.toHaveBeenCalled();
  });

  it("exempts fixture runs from authoritative gate enforcement", async () => {
    delete process.env.GITHUB_TOKEN;

    const fixturePath = path.join(tempRoot, "issue.fixture.md");
    await writeFile(
      fixturePath,
      `---
title: Fixture issue
status: Ready for Planning
projectName: Example Target App
teamName: WES
---

## Target repo

owner/example-target-app

## Task

Add hello page

## Acceptance criteria

- [ ] Route works

## Out of scope

- Harness
`,
      "utf8",
    );

    const result = await runPreflight({
      issueKey: "WES-FIX",
      configPath,
      fixturePath,
    });

    expect(result.success).toBe(true);
    expect(mocks.listTeamWorkflowStates).not.toHaveBeenCalled();
  });
});
