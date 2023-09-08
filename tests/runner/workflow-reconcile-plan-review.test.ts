import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  createEmptyWorkflowState,
  InMemoryWorkflowStateStore,
} from "../../src/workflow/state/index.js";
import type { HarnessConfig } from "../../src/config/types.js";
import { buildPlanReviewSubjectIdentity } from "../../src/workflow/subject-identities.js";
import {
  buildPlanReviewDispatchEffectId,
  buildPlanReviewRequestId,
} from "../../src/workflow/plan-review-dispatch-effect.js";

const mocks = vi.hoisted(() => ({
  fetchLinearIssue: vi.fn(),
  createWorkflowStateStore: vi.fn(),
  resolveRoute: vi.fn(),
  ensurePlanReviewJobDispatched: vi.fn(),
  ensureCodeReviewJobDispatched: vi.fn(),
  transitionIssueStatus: vi.fn(),
  createLinearClient: vi.fn(),
  listIssueComments: vi.fn(),
  runLinearAssociationGate: vi.fn(),
  markRunStatusBlocked: vi.fn(),
  markRevisionPendingPmFeedback: vi.fn(),
  createReconcileJobAndDispatch: vi.fn(),
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

vi.mock("../../src/workflow/plan-review-dispatch-effect.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../src/workflow/plan-review-dispatch-effect.js")
    >();
  return {
    ...actual,
    ensurePlanReviewJobDispatched: mocks.ensurePlanReviewJobDispatched,
  };
});

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

vi.mock("../../src/workflow/job-request/dispatch-reconcile.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../src/workflow/job-request/dispatch-reconcile.js")
    >();
  return {
    ...actual,
    createReconcileJobAndDispatch: mocks.createReconcileJobAndDispatch,
  };
});

vi.mock("../../src/linear/writer.js", () => ({
  createLinearClient: mocks.createLinearClient,
  listIssueComments: mocks.listIssueComments,
  transitionIssueStatus: mocks.transitionIssueStatus,
}));

vi.mock("../../src/linear/run-status-comment.js", () => ({
  markRevisionPendingPmFeedback: mocks.markRevisionPendingPmFeedback,
  markRunStatusBlocked: mocks.markRunStatusBlocked,
}));

vi.mock("../../src/config/linear-association-gate.js", () => ({
  runLinearAssociationGate: mocks.runLinearAssociationGate,
}));

import { evaluateWorkflowReconcileIssue } from "../../src/runner/workflow-reconcile.js";

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

const planGenerationId = "120aa5ff-005a-44e7-aa5a-0b4922d951b4";
const planHash =
  "84076eff91fba2a0d2dd61d7da598f594d6362dd97186f1f3c7e4ef4dec56ba6";
const subjectIdentity = buildPlanReviewSubjectIdentity({
  issueKey: "FRE-6",
  planGenerationId,
  planHash,
  reviewCycle: 0,
});
const reviewRequestId = buildPlanReviewRequestId(subjectIdentity);
const effectId = buildPlanReviewDispatchEffectId(subjectIdentity);

describe("workflow reconcile plan review recovery", () => {
  let store: InMemoryWorkflowStateStore;

  beforeEach(() => {
    vi.clearAllMocks();
    store = new InMemoryWorkflowStateStore();
    mocks.runLinearAssociationGate.mockReturnValue({ ok: true });
    mocks.createLinearClient.mockReturnValue({});
    mocks.listIssueComments.mockResolvedValue([]);
    mocks.createWorkflowStateStore.mockImplementation(async (opts: { teamId?: string }) => {
      // Prefer TT authoritative path when present (FRE-6 dogfood).
      if (opts.teamId === "team-tt" || !opts.teamId) {
        return store;
      }
      return new InMemoryWorkflowStateStore();
    });
    mocks.resolveRoute.mockResolvedValue({
      issueKey: "FRE-6",
      phase: "plan_review",
      shouldRun: false,
      repoConfigId: "portfolio",
      baseBranch: "dev",
      targetRepo: "https://github.com/weston-uribe/weston-uribe-portfolio",
      linearStatus: "Plan Review",
      mergeConcurrencyGroup: "portfolio-dev",
      workflowStateRevision: 1,
      reconcileReason: "not_eligible",
    });
    const base = createEmptyWorkflowState({
      issueKey: "FRE-6",
      workflowSchemaVersion: "product-development-v2",
      effectiveOptionalPhases: { planReview: true, codeReview: false },
    });
    store.seed({
      ...base,
      stateRevision: 1,
      currentPhaseId: "plan_review",
      latestPlanArtifact: {
        planGenerationId,
        planArtifactHash: planHash,
        plannerRunId: "2026-07-21T00-14-47-057Z-FRE-6",
        promptContractVersion: "planning@1",
        workflowStateRevision: 1,
        createdAt: "2026-07-21T00:18:59.522Z",
        supersedesPlanGenerationId: null,
        causedByReviewDecisionIdentity: null,
      },
    });
    mocks.fetchLinearIssue.mockResolvedValue({
      id: "iss-fre6",
      identifier: "FRE-6",
      status: "Plan Review",
      teamId: "team-fre",
      teamKey: "FRE",
      url: "https://linear.app/x/issue/FRE-6",
    });
  });

  it("dry-run reports exact subject and request id for safe recovery", async () => {
    const result = await evaluateWorkflowReconcileIssue({
      config,
      configPath: "/tmp/harness.config.json",
      issueKey: "FRE-6",
      linearApiKey: "lin",
      dryRun: true,
      dispatch: true,
    });

    expect(result.action).toBe("dispatch");
    expect(result.dispatched).toBe(false);
    expect(result.planReviewSubjectIdentity).toBe(subjectIdentity);
    expect(result.planReviewRequestId).toBe(reviewRequestId);
    expect(mocks.ensurePlanReviewJobDispatched).not.toHaveBeenCalled();
  });

  it("recovers when route already marks Plan Review eligible (live FRE-6 shape)", async () => {
    // Production resolveRoute returns shouldRun=true for Plan Review — recovery
    // must still compute subject/request ids and opaque-dispatch, not fall through
    // to plan_review_requires_subject_dispatch.
    mocks.resolveRoute.mockResolvedValue({
      issueKey: "FRE-6",
      phase: "plan_review",
      shouldRun: true,
      repoConfigId: "portfolio",
      baseBranch: "dev",
      targetRepo: "https://github.com/weston-uribe/weston-uribe-portfolio",
      linearStatus: "Plan Review",
      mergeConcurrencyGroup: "portfolio-dev",
      workflowStateRevision: 1,
      reconcileReason: "eligible",
    });
    mocks.ensurePlanReviewJobDispatched.mockResolvedValue({
      outcome: "dispatched",
      reviewRequestId,
      state: {
        ...(await store.load("FRE-6"))!,
        planReviewSubjectIdentity: subjectIdentity,
        sideEffects: [
          {
            identity: effectId,
            kind: "plan_review_dispatch",
            status: "dispatched",
            createdAt: new Date().toISOString(),
            reviewRequestId,
          },
        ],
      },
      httpDispatched: true,
    });

    const dry = await evaluateWorkflowReconcileIssue({
      config,
      configPath: "/tmp/harness.config.json",
      issueKey: "FRE-6",
      linearApiKey: "lin",
      dryRun: true,
      dispatch: true,
    });
    expect(dry.reason).toBe("plan_review_subject_missing_active_or_completed");
    expect(dry.planReviewSubjectIdentity).toBe(subjectIdentity);
    expect(dry.planReviewRequestId).toBe(reviewRequestId);

    const live = await evaluateWorkflowReconcileIssue({
      config,
      configPath: "/tmp/harness.config.json",
      issueKey: "FRE-6",
      linearApiKey: "lin",
      dispatch: true,
    });
    expect(live.dispatched).toBe(true);
    expect(live.reason).toBe("plan_review_subject_missing_active_or_completed");
    expect(mocks.ensurePlanReviewJobDispatched).toHaveBeenCalledTimes(1);
    expect(mocks.createReconcileJobAndDispatch).not.toHaveBeenCalled();
  });

  it("recovers missing webhook via subject dispatch", async () => {
    mocks.ensurePlanReviewJobDispatched.mockResolvedValue({
      outcome: "dispatched",
      reviewRequestId,
      state: {
        ...(await store.load("FRE-6"))!,
        planReviewSubjectIdentity: subjectIdentity,
        sideEffects: [
          {
            identity: effectId,
            kind: "plan_review_dispatch",
            status: "dispatched",
            createdAt: new Date().toISOString(),
            reviewRequestId,
          },
        ],
      },
      httpDispatched: true,
    });

    const result = await evaluateWorkflowReconcileIssue({
      config,
      configPath: "/tmp/harness.config.json",
      issueKey: "FRE-6",
      linearApiKey: "lin",
      dispatch: true,
    });

    expect(result.action).toBe("dispatch");
    expect(result.reason).toBe("plan_review_subject_missing_active_or_completed");
    expect(result.dispatched).toBe(true);
    expect(mocks.ensurePlanReviewJobDispatched).toHaveBeenCalledTimes(1);
    expect(mocks.createReconcileJobAndDispatch).not.toHaveBeenCalled();
  });

  it("alternate association path (TT state) still recovers FRE issue", async () => {
    mocks.ensurePlanReviewJobDispatched.mockResolvedValue({
      outcome: "request_already_present",
      reviewRequestId,
      state: (await store.load("FRE-6"))!,
      httpDispatched: false,
    });

    const result = await evaluateWorkflowReconcileIssue({
      config,
      configPath: "/tmp/harness.config.json",
      issueKey: "FRE-6",
      linearApiKey: "lin",
      dispatch: true,
    });

    expect(result.reason).toBe("plan_review_request_already_present");
    expect(mocks.ensurePlanReviewJobDispatched).toHaveBeenCalled();
  });

  it("second reconcile after recovery is effect-level no-op", async () => {
    mocks.resolveRoute.mockResolvedValue({
      issueKey: "FRE-6",
      phase: "plan_review",
      shouldRun: true,
      repoConfigId: "portfolio",
      baseBranch: "dev",
      targetRepo: "https://github.com/weston-uribe/weston-uribe-portfolio",
      linearStatus: "Plan Review",
      mergeConcurrencyGroup: "portfolio-dev",
      workflowStateRevision: 3,
      reconcileReason: "eligible",
    });
    const recovered = {
      ...(await store.load("FRE-6"))!,
      stateRevision: 3,
      planReviewSubjectIdentity: subjectIdentity,
      planReviewerAgentId: "bc-reviewer-1",
      sideEffects: [
        {
          identity: effectId,
          kind: "plan_review_dispatch" as const,
          status: "dispatched" as const,
          createdAt: "2026-07-21T00:19:05.000Z",
          dispatchedAt: "2026-07-21T00:19:06.000Z",
          reviewRequestId,
        },
      ],
    };
    store.seed(recovered);

    const result = await evaluateWorkflowReconcileIssue({
      config,
      configPath: "/tmp/harness.config.json",
      issueKey: "FRE-6",
      linearApiKey: "lin",
      dispatch: true,
    });

    expect(result.action).toBe("noop");
    expect(result.reason).toBe("plan_review_reviewer_already_present");
    expect(result.planReviewSubjectIdentity).toBe(subjectIdentity);
    expect(mocks.ensurePlanReviewJobDispatched).not.toHaveBeenCalled();
  });

  it("max attempts exhausted projects Blocked with deterministic status comment", async () => {
    mocks.ensurePlanReviewJobDispatched.mockResolvedValue({
      outcome: "max_attempts_exhausted",
      reviewRequestId,
      state: {
        ...(await store.load("FRE-6"))!,
        sideEffects: [
          {
            identity: effectId,
            kind: "plan_review_dispatch",
            status: "blocked",
            createdAt: new Date(Date.now() - 200 * 60 * 1000).toISOString(),
            blockedReason: "max_dispatch_attempts_exhausted",
            reviewRequestId,
            dispatchAttemptCount: 3,
          },
        ],
      },
      httpDispatched: false,
    });

    const result = await evaluateWorkflowReconcileIssue({
      config,
      configPath: "/tmp/harness.config.json",
      issueKey: "FRE-6",
      linearApiKey: "lin",
      dispatch: true,
    });

    expect(result.action).toBe("blocker");
    expect(result.reason).toBe("plan_review_max_dispatch_attempts_exhausted");
    expect(mocks.transitionIssueStatus).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      "Blocked",
    );
    expect(mocks.markRunStatusBlocked).toHaveBeenCalledWith(
      expect.anything(),
      "iss-fre6",
      expect.objectContaining({
        reviewSubjectIdentity: subjectIdentity,
        deliveryId: reviewRequestId,
      }),
    );
  });
});
