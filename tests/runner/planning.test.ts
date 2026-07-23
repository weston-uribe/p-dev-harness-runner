import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getPlanningResultPath } from "../../src/artifacts/paths.js";

const VALID_IMPLEMENTATION_READY_PLAN = `
## Context
Add a hello route for the planning happy-path fixture.

## Approach
1. Add a dedicated hello page route in the target app.
2. Wire navigation so the route is reachable from the home page.
3. Keep changes limited to the hello page and shared nav entry.

## Files to touch
| File | Change |
| --- | --- |
| app/hello/page.tsx | Add hello page |
| components/nav.tsx | Link to hello route |

## Files explicitly out of scope
- Harness orchestration and Linear workflow changes

## Risks
| Risk | Mitigation |
| --- | --- |
| Route naming collision | Use an unused \`/hello\` path |

## Acceptance Verification Plan
- Confirm \`/hello\` renders the expected greeting text.
- Confirm home navigation includes a link to \`/hello\`.
- Automated: run the target app route smoke check if available.

## Rollback
Remove the hello page and nav link in a follow-up commit.
`.trim();

const SHORT_INVALID_PLAN_STUB = "## Implementation plan\n\nStep 1";

const mocks = vi.hoisted(() => ({
  transitionIssueStatus: vi.fn(),
  postPlanningComment: vi.fn(),
  postIssueComment: vi.fn(),
  updateIssueComment: vi.fn(),
  listIssueComments: vi.fn(),
  createLinearClient: vi.fn(),
  createPlanningAgent: vi.fn(),
  disposeAgent: vi.fn(),
  sendAndObserve: vi.fn(),
  fetchLinearIssue: vi.fn(),
}));

vi.mock("../../src/linear/writer.js", () => ({
  transitionIssueStatus: mocks.transitionIssueStatus,
  postPlanningComment: mocks.postPlanningComment,
  postIssueComment: mocks.postIssueComment,
  updateIssueComment: mocks.updateIssueComment,
  listIssueComments: mocks.listIssueComments,
  postErrorComment: vi.fn(),
  postPhaseStartCommentIfNeeded: vi.fn(),
  createLinearClient: mocks.createLinearClient,
}));

vi.mock("../../src/agents/production.js", () => ({
  createPlanningAgent: mocks.createPlanningAgent,
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

import { executePlanningPhase } from "../../src/runner/phases/planning.js";
import type { HarnessConfig } from "../../src/config/types.js";

describe("executePlanningPhase", () => {
  let tempRoot = "";
  let configPath = "";
  const envKeys = [
    "HARNESS_CONFIG_JSON_B64",
    "HARNESS_CONFIG_JSON",
    "HARNESS_CONFIG_PATH",
    "GITHUB_TOKEN",
  ] as const;
  const savedEnv: Partial<Record<(typeof envKeys)[number], string | undefined>> =
    {};

  beforeEach(async () => {
    vi.clearAllMocks();
    for (const key of envKeys) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    tempRoot = await mkdtemp(path.join(tmpdir(), "harness-planning-"));
    const config: HarnessConfig = {
      version: 1,
      orchestratorMarker: "harness-orchestrator-v1",
      logDirectory: tempRoot,
      defaultModel: { id: "composer-2.5" },
      linear: {
        teamKey: "WES",
        eligibleStatuses: {
          planning: ["Ready for Planning"],
          implementation: ["Ready for Build"],
        },
        transitionalStatuses: {
          planningInProgress: "Planning",
          buildingInProgress: "Building",
          prOpen: "PR Open",
          pmReview: "PM Review",
          blocked: "Blocked",
          readyForBuild: "Ready for Build",
        },
      },
      planning: { timeoutSeconds: 60 },
      repos: [
        {
          id: "target-app",
          linearProjects: ["Example Target App"],
          targetRepo: "https://github.com/owner/example-target-app",
          baseBranch: "main",
          previewProvider: "vercel",
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

    mocks.listIssueComments.mockResolvedValue([]);
    mocks.postIssueComment.mockResolvedValue("status-comment-1");
    mocks.updateIssueComment.mockResolvedValue(undefined);
    mocks.transitionIssueStatus.mockResolvedValue(undefined);
    mocks.postPlanningComment.mockResolvedValue("comment-1");
    mocks.createLinearClient.mockReturnValue({});

    const mockHandle = { __brand: Symbol("AgentHandle") };
    mocks.createPlanningAgent.mockResolvedValue(mockHandle);
    mocks.disposeAgent.mockResolvedValue(undefined);
    mocks.sendAndObserve.mockResolvedValue({
      agentId: "agent-abc",
      runId: "run-xyz",
      assistantText: VALID_IMPLEMENTATION_READY_PLAN,
      result: { id: "run-xyz", status: "completed" },
    });

    mocks.fetchLinearIssue.mockImplementation(async (issueKey: string) => {
      if (issueKey === "WES-PLAN") {
        return {
          id: "issue-plan",
          identifier: "WES-PLAN",
          title: "Plan hello world",
          description: `## Target repo\n\nowner/example-target-app\n\n## Task\n\nAdd hello page\n\n## Acceptance criteria\n\n- [ ] Route works\n\n## Out of scope\n\n- Harness`,
          status: "Ready for Planning",
          projectName: "Example Target App",
          teamName: "WES",
          teamKey: null,
          teamId: "team-1",
          url: null,
        };
      }
      return {
        id: "issue-plan",
        identifier: "WES-PLAN",
        title: "Plan hello world",
        description: "",
        status: "Ready for Build",
        projectName: "Example Target App",
        teamName: "WES",
        teamKey: null,
        teamId: "team-1",
        url: null,
      };
    });
  });

  afterEach(async () => {
    delete process.env.LINEAR_API_KEY;
    delete process.env.CURSOR_API_KEY;
    for (const key of envKeys) {
      const value = savedEnv[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    await rm(tempRoot, { recursive: true, force: true });
  });

  it("runs happy path with Planning and Ready for Build transitions", async () => {
    const result = await executePlanningPhase({
      issueKey: "WES-PLAN",
      configPath,
    });

    expect(result.manifest.errorClassification).toBeNull();
    expect(result.manifest.validationSummary).toBeNull();
    expect(result.exitCode).toBe(0);
    expect(result.manifest.finalOutcome).toBe("success");
    expect(result.manifest.cursorAgentId).toBe("agent-abc");
    expect(result.manifest.cursorRunId).toBe("run-xyz");
    expect(result.manifest.linearStatusBefore).toBe("Ready for Planning");
    expect(result.manifest.linearStatusAfter).toBe("Ready for Build");
    expect(result.manifest.dryRun).toBe(false);
    expect(result.manifest.milestone).toBe("v0.3-prep");

    expect(mocks.transitionIssueStatus).toHaveBeenCalledTimes(2);
    expect(mocks.postPlanningComment).toHaveBeenCalledTimes(1);
    expect(mocks.sendAndObserve).toHaveBeenCalledTimes(1);
  });

  it("repairs a short plan stub on the second sendAndObserve call", async () => {
    mocks.sendAndObserve
      .mockResolvedValueOnce({
        agentId: "agent-abc",
        runId: "run-stub",
        assistantText: SHORT_INVALID_PLAN_STUB,
        result: { id: "run-stub", status: "completed" },
      })
      .mockResolvedValueOnce({
        agentId: "agent-abc",
        runId: "run-repaired",
        assistantText: VALID_IMPLEMENTATION_READY_PLAN,
        result: { id: "run-repaired", status: "completed" },
      });

    const result = await executePlanningPhase({
      issueKey: "WES-PLAN",
      configPath,
    });

    expect(result.manifest.errorClassification).toBeNull();
    expect(result.exitCode).toBe(0);
    expect(result.manifest.finalOutcome).toBe("success");
    expect(mocks.sendAndObserve).toHaveBeenCalledTimes(2);
    expect(result.manifest.cursorRunId).toBe("run-repaired");
    expect(mocks.postPlanningComment).toHaveBeenCalledWith(
      expect.anything(),
      "issue-plan",
      VALID_IMPLEMENTATION_READY_PLAN,
      expect.objectContaining({
        cursorRunId: "run-repaired",
        phase: "planning",
      }),
      { planReviewNext: false },
    );

    const planningResultPath = getPlanningResultPath(result.runDirectory);
    const persisted = await readFile(planningResultPath, "utf8");
    expect(persisted.trim()).toBe(VALID_IMPLEMENTATION_READY_PLAN);
  });

  it("skips stale wrong_status when issue left Ready for Planning before claim", async () => {
    mocks.fetchLinearIssue.mockResolvedValue({
      id: "issue-plan",
      identifier: "WES-PLAN",
      title: "Plan hello world",
      description: `## Target repo\n\nowner/example-target-app\n\n## Task\n\nAdd hello page\n\n## Acceptance criteria\n\n- [ ] Route works\n\n## Out of scope\n\n- Harness`,
      status: "Blocked",
      projectName: "Example Target App",
      teamName: "WES",
      teamKey: null,
      teamId: "team-1",
      url: null,
    });

    const result = await executePlanningPhase({
      issueKey: "WES-PLAN",
      configPath,
    });

    expect(result.exitCode).toBe(0);
    expect(result.manifest.finalOutcome).toBe("skipped");
    expect(result.manifest.errorClassification).toBe("wrong_status");
    expect(result.manifest.validationSummary).toMatch(/wrong_status/);
    expect(mocks.transitionIssueStatus).not.toHaveBeenCalled();
    expect(mocks.createPlanningAgent).not.toHaveBeenCalled();
  });
});
