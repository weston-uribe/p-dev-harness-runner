import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  createEmptyWorkflowState,
  InMemoryWorkflowStateStore,
} from "../../src/workflow/state/index.js";
import type { HarnessConfig } from "../../src/config/types.js";

const mocks = vi.hoisted(() => ({
  fetchLinearIssue: vi.fn(),
  createWorkflowStateStore: vi.fn(),
  resolveRoute: vi.fn(),
  ensureCodeReviewJobDispatched: vi.fn(),
  transitionIssueStatus: vi.fn(),
  createLinearClient: vi.fn(),
  listIssueComments: vi.fn(),
  runLinearAssociationGate: vi.fn(),
}));

vi.mock("../../src/linear/client.js", () => ({
  fetchLinearIssue: mocks.fetchLinearIssue,
}));

vi.mock("../../src/workflow/state/factory.js", () => ({
  createWorkflowStateStore: mocks.createWorkflowStateStore,
  resolveWorkflowStateStoreMode: () => "memory",
}));

vi.mock("../../src/runner/resolve-route.js", () => ({
  resolveRoute: mocks.resolveRoute,
}));

vi.mock("../../src/workflow/code-review-dispatch-effect.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../src/workflow/code-review-dispatch-effect.js")
    >();
  return {
    ...actual,
    ensureCodeReviewJobDispatched: mocks.ensureCodeReviewJobDispatched,
  };
});

vi.mock("../../src/linear/writer.js", () => ({
  createLinearClient: mocks.createLinearClient,
  listIssueComments: mocks.listIssueComments,
  transitionIssueStatus: mocks.transitionIssueStatus,
}));

vi.mock("../../src/config/linear-association-gate.js", () => ({
  runLinearAssociationGate: mocks.runLinearAssociationGate,
}));

import {
  evaluateWorkflowReconcileIssue,
  reconcileWorkflowStateTeamCandidates,
} from "../../src/runner/workflow-reconcile.js";

const config = {
  version: 1,
  orchestratorMarker: "harness-orchestrator-v1",
  logDirectory: "/tmp",
  defaultModel: { id: "composer-2.5" },
  linear: {
    teamKey: "FRE",
    eligibleStatuses: {
      planning: ["Ready for Planning"],
      handoff: ["PR Open"],
      revision: ["Needs Revision"],
      merge: ["Ready to Merge"],
    },
  },
  repos: [],
  allowedTargetRepos: [],
} as unknown as HarnessConfig;

const multiTeamConfig = {
  ...config,
  repos: [
    {
      id: "portfolio",
      targetRepo: "https://github.com/weston-uribe/weston-uribe-portfolio",
      baseBranch: "dev",
      linearAssociations: [
        {
          workspaceId: "ws",
          teamId: "team-tt",
          teamKey: "TT",
          projectId: "proj-tt",
        },
        {
          workspaceId: "ws",
          teamId: "team-fre",
          teamKey: "FRE",
          projectId: "proj-fre",
        },
      ],
    },
  ],
  allowedTargetRepos: [
    "https://github.com/weston-uribe/weston-uribe-portfolio",
  ],
} as unknown as HarnessConfig;

const artifact = {
  implementationGenerationId: "8d3bb8dd-8aac-426c-a036-9febc79abf9a",
  targetRepository: "https://github.com/weston-uribe/weston-uribe-portfolio",
  prNumber: 50,
  prUrl: "https://github.com/weston-uribe/weston-uribe-portfolio/pull/50",
  headSha: "cf71f1481c9b968219c58919839c0885fa2b8cc6",
  baseSha: "bd3f39261731969117bcbaa7327983d8ee6ce669",
  diffHash: "eae973d70791911cbc46dfa912bf57b6d2159a162697f5617fcbd53f15a2cf05",
  builderRunId: "run-1",
  acceptanceEvidenceId: null,
  testEvidenceId: null,
  workflowStateRevision: 3,
  createdAt: "2026-07-20T18:41:17.263Z",
  supersedesImplementationGenerationId: null,
  causedByReviewDecisionIdentity: null,
};

describe("evaluateWorkflowReconcileIssue code review recovery", () => {
  let store: InMemoryWorkflowStateStore;

  beforeEach(() => {
    vi.clearAllMocks();
    store = new InMemoryWorkflowStateStore();
    const base = createEmptyWorkflowState({
      issueKey: "FRE-5",
      workflowSchemaVersion: "product-development-v2",
    });
    store.seed({
      ...base,
      stateRevision: 3,
      currentPhaseId: "code_review",
      handoffSubjectIdentity: "1f30fae5d07d0d31f067d83fbf4f510d",
      latestImplementationArtifact: artifact,
      sideEffects: [
        {
          identity:
            "linear_status_transition:1f30fae5d07d0d31f067d83fbf4f510d:code_review",
          kind: "linear_status_transition",
          status: "pending",
          createdAt: "2026-07-20T18:41:17.264Z",
        },
      ],
    });
    mocks.createWorkflowStateStore.mockResolvedValue(store);
    mocks.runLinearAssociationGate.mockReturnValue({ ok: true });
    mocks.resolveRoute.mockResolvedValue({
      shouldRun: false,
      phase: "none",
      reconcileReason: "not_eligible",
      workflowStateRevision: 3,
    });
    mocks.createLinearClient.mockReturnValue({});
    mocks.listIssueComments.mockResolvedValue([]);
    mocks.transitionIssueStatus.mockResolvedValue(undefined);
    mocks.fetchLinearIssue.mockResolvedValue({
      id: "issue-fre-5",
      identifier: "FRE-5",
      title: "Add Kinterra",
      description: "",
      status: "Blocked",
      projectName: "harness",
      teamName: "FRE",
      teamKey: "FRE",
      teamId: "team-1",
      url: "https://linear.app/example/issue/FRE-5",
    });
  });

  afterEach(() => {
    delete process.env.GITHUB_DISPATCH_TOKEN;
    delete process.env.HARNESS_GITHUB_TOKEN;
  });

  it("recovers Blocked + durable code_review with one dispatch and Linear projection", async () => {
    mocks.ensureCodeReviewJobDispatched.mockResolvedValue({
      outcome: "dispatched",
      reviewRequestId: "cr-subject:abc",
      state: (await store.load("FRE-5"))!,
      httpDispatched: true,
    });

    const result = await evaluateWorkflowReconcileIssue({
      config,
      configPath: "/tmp/harness.config.json",
      issueKey: "FRE-5",
      linearApiKey: "lin",
      dispatch: true,
    });

    expect(result.action).toBe("dispatch");
    expect(result.reason).toBe("code_review_subject_missing_active_or_completed");
    expect(result.dispatched).toBe(true);
    expect(mocks.ensureCodeReviewJobDispatched).toHaveBeenCalledTimes(1);
    expect(mocks.transitionIssueStatus).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      "Code Review",
    );
  });

  it("returns blocker for missing_dispatch_token without throwing", async () => {
    mocks.ensureCodeReviewJobDispatched.mockResolvedValue({
      outcome: "missing_dispatch_token",
      reviewRequestId: "cr-subject:abc",
      state: (await store.load("FRE-5"))!,
      httpDispatched: false,
    });

    const result = await evaluateWorkflowReconcileIssue({
      config,
      configPath: "/tmp/harness.config.json",
      issueKey: "FRE-5",
      linearApiKey: "lin",
      dispatch: true,
    });

    expect(result.action).toBe("blocker");
    expect(result.reason).toBe("missing_dispatch_token");
    expect(result.dispatched).toBe(false);
    expect(mocks.transitionIssueStatus).not.toHaveBeenCalled();
  });

  it("proves existing request without a second repository_dispatch", async () => {
    mocks.ensureCodeReviewJobDispatched.mockResolvedValue({
      outcome: "request_already_present",
      reviewRequestId: "cr-subject:abc",
      state: (await store.load("FRE-5"))!,
      httpDispatched: false,
    });

    const result = await evaluateWorkflowReconcileIssue({
      config,
      configPath: "/tmp/harness.config.json",
      issueKey: "FRE-5",
      linearApiKey: "lin",
      dispatch: true,
    });

    expect(result.reason).toBe("code_review_request_already_present");
    expect(result.dispatched).toBe(false);
    expect(mocks.transitionIssueStatus).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      "Code Review",
    );
  });

  it("loads durable state from config-authoritative team when issue team path is empty", async () => {
    const emptyIssueTeamStore = new InMemoryWorkflowStateStore();
    const authoritativeStore = new InMemoryWorkflowStateStore();
    const base = createEmptyWorkflowState({
      issueKey: "FRE-5",
      workflowSchemaVersion: "product-development-v2",
    });
    authoritativeStore.seed({
      ...base,
      stateRevision: 3,
      currentPhaseId: "code_review",
      handoffSubjectIdentity: "1f30fae5d07d0d31f067d83fbf4f510d",
      latestImplementationArtifact: artifact,
    });
    mocks.createWorkflowStateStore.mockImplementation(async (input: { teamId?: string }) => {
      if (input.teamId === "team-fre") return emptyIssueTeamStore;
      if (input.teamId === "team-tt") return authoritativeStore;
      throw new Error(`unexpected teamId ${input.teamId}`);
    });
    mocks.fetchLinearIssue.mockResolvedValue({
      id: "issue-fre-5",
      identifier: "FRE-5",
      title: "Add Kinterra",
      description: "",
      status: "Blocked",
      projectName: "harness",
      teamName: "FRE",
      teamKey: "FRE",
      teamId: "team-fre",
      projectId: "proj-fre",
      url: "https://linear.app/example/issue/FRE-5",
    });
    mocks.ensureCodeReviewJobDispatched.mockResolvedValue({
      outcome: "dispatched",
      reviewRequestId: "cr-subject:abc",
      state: (await authoritativeStore.load("FRE-5"))!,
      httpDispatched: true,
    });

    expect(
      reconcileWorkflowStateTeamCandidates({
        config: multiTeamConfig,
        issueTeamId: "team-fre",
      }),
    ).toEqual(["team-fre", "team-tt"]);

    const result = await evaluateWorkflowReconcileIssue({
      config: multiTeamConfig,
      configPath: "/tmp/harness.config.json",
      issueKey: "FRE-5",
      linearApiKey: "lin",
      dispatch: true,
    });

    expect(mocks.createWorkflowStateStore).toHaveBeenCalledWith(
      expect.objectContaining({ teamId: "team-fre" }),
    );
    expect(mocks.createWorkflowStateStore).toHaveBeenCalledWith(
      expect.objectContaining({ teamId: "team-tt" }),
    );
    expect(result.action).toBe("dispatch");
    expect(result.reason).toBe("code_review_subject_missing_active_or_completed");
    expect(result.dispatched).toBe(true);
    expect(mocks.ensureCodeReviewJobDispatched).toHaveBeenCalledWith(
      expect.objectContaining({ store: authoritativeStore }),
    );
  });

  it("running reconcile twice still invokes ensure once per call but ensure itself is idempotent", async () => {
    mocks.ensureCodeReviewJobDispatched
      .mockResolvedValueOnce({
        outcome: "dispatched",
        reviewRequestId: "cr-subject:abc",
        state: (await store.load("FRE-5"))!,
        httpDispatched: true,
      })
      .mockResolvedValueOnce({
        outcome: "already_dispatched",
        reviewRequestId: "cr-subject:abc",
        state: (await store.load("FRE-5"))!,
        httpDispatched: false,
      });

    const first = await evaluateWorkflowReconcileIssue({
      config,
      configPath: "/tmp/harness.config.json",
      issueKey: "FRE-5",
      linearApiKey: "lin",
      dispatch: true,
    });
    mocks.fetchLinearIssue.mockResolvedValue({
      id: "issue-fre-5",
      identifier: "FRE-5",
      title: "Add Kinterra",
      description: "",
      status: "Code Review",
      projectName: "harness",
      teamName: "FRE",
      teamKey: "FRE",
      teamId: "team-1",
      url: "https://linear.app/example/issue/FRE-5",
    });
    // After first recovery, durable should show accepted review or dispatched —
    // simulate accepted so second reconcile noops on review subject.
    const after = (await store.load("FRE-5"))!;
    store.seed({
      ...after,
      acceptedReviewSubjects: { "any": "decision" },
      activeReviewSubjectIdentity: "subject",
    });
    // Force ensure path again with already_dispatched by clearing accepted for this test's second call:
    // instead call ensure path with Code Review and no accepted — mock already_dispatched.
    store.seed({
      ...after,
      acceptedReviewSubjects: {},
      activeReviewSubjectIdentity: null,
    });

    const second = await evaluateWorkflowReconcileIssue({
      config,
      configPath: "/tmp/harness.config.json",
      issueKey: "FRE-5",
      linearApiKey: "lin",
      dispatch: true,
    });

    expect(first.dispatched).toBe(true);
    expect(second.reason).toBe("code_review_request_already_present");
    expect(second.dispatched).toBe(false);
    expect(mocks.ensureCodeReviewJobDispatched).toHaveBeenCalledTimes(2);
  });
});
