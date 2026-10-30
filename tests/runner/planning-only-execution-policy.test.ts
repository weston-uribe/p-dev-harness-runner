import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STOP_AFTER_PLANNING_LABEL } from "../../src/workflow/execution-policy.js";
import { hashProviderIdentity } from "../../src/identity/provider-identity-hash.js";

const VALID_IMPLEMENTATION_READY_PLAN = `
## Context
Add a hello route for the planning-only fixture.

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

const mocks = vi.hoisted(() => ({
  transitionIssueStatus: vi.fn(),
  transitionIssueStatusById: vi.fn(),
  postPlanningComment: vi.fn(),
  postIssueComment: vi.fn(),
  updateIssueComment: vi.fn(),
  listIssueComments: vi.fn(),
  createLinearClient: vi.fn(),
  createPlanningAgent: vi.fn(),
  disposeAgent: vi.fn(),
  sendAndObserve: vi.fn(),
  fetchLinearIssue: vi.fn(),
  listTeamWorkflowStates: vi.fn(),
}));

vi.mock("../../src/setup/linear-setup-client.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/setup/linear-setup-client.js")>();
  return {
    ...actual,
    listTeamWorkflowStates: mocks.listTeamWorkflowStates,
  };
});

vi.mock("../../src/linear/writer.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/linear/writer.js")>();
  return {
    ...actual,
    transitionIssueStatus: mocks.transitionIssueStatus,
    transitionIssueStatusById: mocks.transitionIssueStatusById,
    postPlanningComment: mocks.postPlanningComment,
    postIssueComment: mocks.postIssueComment,
    updateIssueComment: mocks.updateIssueComment,
    listIssueComments: mocks.listIssueComments,
    postErrorComment: vi.fn(),
    postPhaseStartCommentIfNeeded: vi.fn(),
    createLinearClient: mocks.createLinearClient,
  };
});

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

const TEAM_WORKFLOW_STATES = [
  { id: "s-rfp", name: "Ready for Planning", type: "unstarted" },
  { id: "s-planning", name: "Planning", type: "started" },
  { id: "s-rfb", name: "Ready for Build", type: "unstarted" },
  { id: "s-canceled", name: "Canceled", type: "canceled" },
];

function issueSnapshot(input: {
  status: string;
  statusId: string;
  labels?: Array<{ id: string; name: string }>;
}) {
  return {
    id: "issue-plan",
    identifier: "WES-PLAN",
    title: "Plan hello world",
    description: `## Target repo\n\nowner/example-target-app\n\n## Task\n\nAdd hello page\n\n## Acceptance criteria\n\n- [ ] Route works\n\n## Out of scope\n\n- Harness`,
    status: input.status,
    statusId: input.statusId,
    labels: input.labels ?? [],
    projectName: "Example Target App",
    teamName: "WES",
    teamKey: null,
    teamId: "team-1",
    url: null,
  };
}

describe("executePlanningPhase stop-after-planning execution policy", () => {
  let tempRoot = "";
  let configPath = "";
  const envKeys = [
    "HARNESS_CONFIG_JSON_B64",
    "HARNESS_CONFIG_JSON",
    "HARNESS_CONFIG_PATH",
    "GITHUB_TOKEN",
    "LINEAR_DELIVERY_ID",
  ] as const;
  const savedEnv: Partial<Record<(typeof envKeys)[number], string | undefined>> =
    {};

  beforeEach(async () => {
    vi.clearAllMocks();
    for (const key of envKeys) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }

    tempRoot = await mkdtemp(path.join(tmpdir(), "harness-planning-only-"));
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
      allowedTargetRepos: ["https://github.com/owner/example-target-app"],
    };
    configPath = path.join(tempRoot, "harness.config.json");
    await writeFile(configPath, JSON.stringify(config), "utf8");

    process.env.LINEAR_API_KEY = "test-linear-key";
    process.env.CURSOR_API_KEY = "test-cursor-key";
    process.env.LINEAR_DELIVERY_ID = "dlv-planning-only-ingress";

    mocks.listIssueComments.mockResolvedValue([]);
    mocks.postIssueComment.mockResolvedValue("status-comment-1");
    mocks.updateIssueComment.mockResolvedValue(undefined);
    mocks.transitionIssueStatus.mockResolvedValue(undefined);
    mocks.transitionIssueStatusById.mockResolvedValue(undefined);
    mocks.postPlanningComment.mockResolvedValue("comment-plan-only");
    mocks.createLinearClient.mockReturnValue({});
    mocks.listTeamWorkflowStates.mockResolvedValue(TEAM_WORKFLOW_STATES);

    const mockHandle = { __brand: Symbol("AgentHandle") };
    mocks.createPlanningAgent.mockResolvedValue(mockHandle);
    mocks.disposeAgent.mockResolvedValue(undefined);
    mocks.sendAndObserve.mockResolvedValue({
      agentId: "agent-plan-only",
      runId: "run-plan-only",
      assistantText: VALID_IMPLEMENTATION_READY_PLAN,
      result: { id: "run-plan-only", status: "completed" },
    });

    mocks.fetchLinearIssue.mockImplementation(async (issueKey: string) => {
      if (issueKey === "WES-PLAN") {
        return issueSnapshot({
          status: "Ready for Planning",
          statusId: "s-rfp",
        });
      }
      return issueSnapshot({
        status: "Ready for Build",
        statusId: "s-rfb",
      });
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

  it("terminalizes to Canceled after planning when stop-after-planning label is present", async () => {
    const policyLabels = [{ id: "label-stop", name: STOP_AFTER_PLANNING_LABEL }];
    mocks.fetchLinearIssue
      .mockResolvedValueOnce(
        issueSnapshot({
          status: "Ready for Planning",
          statusId: "s-rfp",
          labels: policyLabels,
        }),
      )
      .mockResolvedValueOnce(
        issueSnapshot({
          status: "Ready for Planning",
          statusId: "s-rfp",
          labels: policyLabels,
        }),
      )
      .mockResolvedValueOnce(
        issueSnapshot({
          status: "Planning",
          statusId: "s-planning",
          labels: policyLabels,
        }),
      )
      .mockResolvedValueOnce(
        issueSnapshot({
          status: "Canceled",
          statusId: "s-canceled",
          labels: policyLabels,
        }),
      );

    const result = await executePlanningPhase({
      issueKey: "WES-PLAN",
      configPath,
    });

    expect(result.exitCode).toBe(0);
    expect(result.manifest.finalOutcome).toBe("success");
    expect(result.manifest.linearStatusAfter).toBe("Canceled");
    expect(mocks.transitionIssueStatus).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ identifier: "WES-PLAN" }),
      "Planning",
    );
    expect(mocks.transitionIssueStatusById).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ identifier: "WES-PLAN" }),
      "s-canceled",
    );
    expect(mocks.transitionIssueStatus).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      "Ready for Build",
    );
    expect(mocks.postPlanningComment).toHaveBeenCalledWith(
      expect.anything(),
      "issue-plan",
      VALID_IMPLEMENTATION_READY_PLAN,
      expect.objectContaining({
        cursorRunIdHash: hashProviderIdentity("run-plan-only"),
        phase: "planning",
      }),
      { planningOnlyTerminal: true },
    );
  });

  it("keeps ordinary planning unchanged when no execution policy label is present", async () => {
    const result = await executePlanningPhase({
      issueKey: "WES-PLAN",
      configPath,
    });

    expect(result.exitCode).toBe(0);
    expect(result.manifest.finalOutcome).toBe("success");
    expect(result.manifest.linearStatusAfter).toBe("Ready for Build");
    expect(mocks.transitionIssueStatusById).not.toHaveBeenCalled();
    expect(mocks.postPlanningComment).toHaveBeenCalledWith(
      expect.anything(),
      "issue-plan",
      VALID_IMPLEMENTATION_READY_PLAN,
      expect.objectContaining({ phase: "planning" }),
      { planReviewNext: false },
    );
  });

  it("fails closed on first claim when LINEAR_DELIVERY_ID is missing", async () => {
    delete process.env.LINEAR_DELIVERY_ID;
    mocks.fetchLinearIssue.mockImplementation(async () =>
      issueSnapshot({
        status: "Ready for Planning",
        statusId: "s-rfp",
        labels: [{ id: "label-stop", name: STOP_AFTER_PLANNING_LABEL }],
      }),
    );

    const result = await executePlanningPhase({
      issueKey: "WES-PLAN",
      configPath,
    });

    expect(result.exitCode).toBe(3);
    expect(result.manifest.finalOutcome).toBe("failed");
    expect(result.manifest.errorClassification).toBe("configuration_error");
    expect(result.manifest.validationSummary).toContain("LINEAR_DELIVERY_ID");
    expect(mocks.sendAndObserve).not.toHaveBeenCalled();
  });
});
