import { describe, expect, it, vi, beforeEach } from "vitest";
import type { HarnessConfig } from "../../src/config/types.js";
import {
  createEmptyWorkflowState,
  InMemoryWorkflowStateStore,
} from "../../src/workflow/state/index.js";
import { buildImplementationSubjectIdentity } from "../../src/workflow/subject-identities.js";
import {
  buildImplementationRequestId,
} from "../../src/workflow/implementation-dispatch-effect.js";

const mocks = vi.hoisted(() => ({
  fetchLinearIssue: vi.fn(),
  createWorkflowStateStore: vi.fn(),
  resolveRoute: vi.fn(),
  createReconcileJobAndDispatch: vi.fn(),
  ensureImplementationJobDispatched: vi.fn(),
  ensurePlanReviewJobDispatched: vi.fn(),
  ensureCodeReviewJobDispatched: vi.fn(),
  createLinearClient: vi.fn(),
  listIssueComments: vi.fn(),
  transitionIssueStatus: vi.fn(),
  runLinearAssociationGate: vi.fn(),
  markRunStatusBlocked: vi.fn(),
  markRevisionPendingPmFeedback: vi.fn(),
  resolveImplementationSubject: vi.fn(),
  createGithubJobRequestStoreFromEnv: vi.fn(),
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

vi.mock("../../src/workflow/implementation-dispatch-effect.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../src/workflow/implementation-dispatch-effect.js")
    >();
  return {
    ...actual,
    ensureImplementationJobDispatched: mocks.ensureImplementationJobDispatched,
  };
});

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

vi.mock("../../src/workflow/resolve-implementation-subject.js", () => ({
  resolveImplementationSubject: mocks.resolveImplementationSubject,
}));

vi.mock("../../src/workflow/job-request/runtime-store.js", () => ({
  createGithubJobRequestStoreFromEnv: mocks.createGithubJobRequestStoreFromEnv,
}));

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
      implementation: ["Ready for Build"],
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
const subjectIdentity = buildImplementationSubjectIdentity({
  issueKey: "FRE-6",
  targetRepo: "https://github.com/weston-uribe/weston-uribe-portfolio",
  baseBranch: "dev",
  planGenerationId,
  planArtifactHash: planHash,
  implementationCycle: 0,
});
const requestId = buildImplementationRequestId(subjectIdentity);

describe("workflow reconcile implementation subject race", () => {
  let store: InMemoryWorkflowStateStore;

  beforeEach(() => {
    vi.clearAllMocks();
    store = new InMemoryWorkflowStateStore();
    mocks.runLinearAssociationGate.mockReturnValue({ ok: true });
    mocks.createLinearClient.mockReturnValue({});
    mocks.listIssueComments.mockResolvedValue([]);
    mocks.createWorkflowStateStore.mockResolvedValue(store);
    const base = createEmptyWorkflowState({
      issueKey: "FRE-6",
      workflowSchemaVersion: "product-development-v2",
    });
    store.seed({
      ...base,
      stateRevision: 5,
      currentPhaseId: "implementation_dispatch",
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
      status: "Ready for Build",
      teamId: "team-tt",
      teamKey: "TT",
      description: "Target repo: https://github.com/weston-uribe/weston-uribe-portfolio",
      url: "https://linear.app/x/issue/FRE-6",
    });
    mocks.resolveRoute.mockResolvedValue({
      issueKey: "FRE-6",
      phase: "implementation",
      shouldRun: true,
      repoConfigId: "portfolio",
      baseBranch: "dev",
      targetRepo: "https://github.com/weston-uribe/weston-uribe-portfolio",
      linearStatus: "Ready for Build",
      mergeConcurrencyGroup: "portfolio-dev",
      workflowStateRevision: 5,
      reconcileReason: "eligible",
    });
    mocks.resolveImplementationSubject.mockResolvedValue({
      subjectIdentity,
      targetRepo: "https://github.com/weston-uribe/weston-uribe-portfolio",
      baseBranch: "dev",
      planGenerationId,
      planArtifactHash: planHash,
      implementationCycle: 0,
      state: store.seed ? undefined : null,
      stateStore: store,
      workflowStateRevision: 5,
    });
    // Ensure resolve returns current seeded state
    mocks.resolveImplementationSubject.mockImplementation(async () => ({
      subjectIdentity,
      targetRepo: "https://github.com/weston-uribe/weston-uribe-portfolio",
      baseBranch: "dev",
      planGenerationId,
      planArtifactHash: planHash,
      implementationCycle: 0,
      state: await store.load("FRE-6"),
      stateStore: store,
      workflowStateRevision: 5,
    }));
  });

  it("FRE-6-shaped: dry-run reports subject + request; live uses subject dispatch not generic reconcile", async () => {
    // Webhook-shaped request id (dlv-5993573…) vs reconcile-shaped (dlv-f36980bf…)
    // must converge on the same impl-subject request.
    expect(requestId).toMatch(/^dlv-/);
    expect(requestId).not.toBe("dlv-5993573ffdd133e66e30cd6d5d27d57a");
    expect(requestId).not.toBe("dlv-f36980bf435aea2e2a23bca239e820d3");

    const dry = await evaluateWorkflowReconcileIssue({
      config,
      configPath: "/tmp/harness.config.json",
      issueKey: "FRE-6",
      linearApiKey: "lin",
      dryRun: true,
      dispatch: true,
    });
    expect(dry.phase).toBe("implementation");
    expect(dry.action).toBe("dispatch");
    expect(dry.reason).toBe("implementation_subject_missing_active_or_completed");
    expect(dry.implementationSubjectIdentity).toBe(subjectIdentity);
    expect(dry.implementationRequestId).toBe(requestId);
    expect(mocks.ensureImplementationJobDispatched).not.toHaveBeenCalled();
    expect(mocks.createReconcileJobAndDispatch).not.toHaveBeenCalled();

    mocks.ensureImplementationJobDispatched.mockResolvedValue({
      outcome: "dispatched",
      reviewRequestId: requestId,
      state: (await store.load("FRE-6"))!,
      httpDispatched: true,
    });

    const live = await evaluateWorkflowReconcileIssue({
      config,
      configPath: "/tmp/harness.config.json",
      issueKey: "FRE-6",
      linearApiKey: "lin",
      dispatch: true,
    });
    expect(live.dispatched).toBe(true);
    expect(mocks.ensureImplementationJobDispatched).toHaveBeenCalledTimes(1);
    expect(mocks.createReconcileJobAndDispatch).not.toHaveBeenCalled();
  });

  it("second reconcile after dispatch is effect-level no-op", async () => {
    mocks.ensureImplementationJobDispatched.mockResolvedValue({
      outcome: "already_dispatched",
      reviewRequestId: requestId,
      state: {
        ...(await store.load("FRE-6"))!,
        builderAgentId: "bc-9d42ed03-7a8c-4099-ab55-7e0e3b958371",
        implementationSubjectIdentity: subjectIdentity,
      },
      httpDispatched: false,
    });
    store.seed({
      ...(await store.load("FRE-6"))!,
      builderAgentId: "bc-9d42ed03-7a8c-4099-ab55-7e0e3b958371",
      implementationSubjectIdentity: subjectIdentity,
    });

    const result = await evaluateWorkflowReconcileIssue({
      config,
      configPath: "/tmp/harness.config.json",
      issueKey: "FRE-6",
      linearApiKey: "lin",
      dispatch: true,
    });
    expect(result.action).toBe("noop");
    expect(result.reason).toBe("implementation_builder_already_present");
    expect(mocks.createReconcileJobAndDispatch).not.toHaveBeenCalled();
  });

  it("phase-pinned plan_review after Ready for Build never launches implementation", async () => {
    const planSubject = "7d2788866fd1b57a962f37ff9269c934";
    store.seed({
      ...(await store.load("FRE-6"))!,
      planReviewSubjectIdentity: planSubject,
      planReviewerAgentId: "bc-a24b5e0f-bea3-4acf-8ad9-a48610734b4d",
    });

    const result = await evaluateWorkflowReconcileIssue({
      config,
      configPath: "/tmp/harness.config.json",
      issueKey: "FRE-6",
      linearApiKey: "lin",
      dispatch: true,
      phase: "plan_review",
    });
    expect(result.pinMode).toBe("phase");
    expect(result.phase).toBe("plan_review");
    expect(result.action).toBe("noop");
    expect(result.reason).toContain("pinned_plan_review");
    expect(mocks.ensureImplementationJobDispatched).not.toHaveBeenCalled();
    expect(mocks.createReconcileJobAndDispatch).not.toHaveBeenCalled();
  });

  it("request-id pin inspects envelope without phase reinterpretation", async () => {
    mocks.createGithubJobRequestStoreFromEnv.mockResolvedValue({
      load: vi.fn().mockResolvedValue({
        requestId: "dlv-f36980bf435aea2e2a23bca239e820d3",
        phase: "implementation",
        state: "pending",
        completionState: null,
        reviewSubjectIdentity: null,
        issueKey: "FRE-6",
      }),
    });

    const result = await evaluateWorkflowReconcileIssue({
      config,
      configPath: "/tmp/harness.config.json",
      issueKey: "FRE-6",
      linearApiKey: "lin",
      dispatch: true,
      requestId: "dlv-f36980bf435aea2e2a23bca239e820d3",
    });
    expect(result.pinMode).toBe("request_id");
    expect(result.action).toBe("noop");
    expect(result.reason).toBe("pinned_request_pending");
    expect(mocks.ensureImplementationJobDispatched).not.toHaveBeenCalled();
    expect(mocks.createReconcileJobAndDispatch).not.toHaveBeenCalled();
  });
});
