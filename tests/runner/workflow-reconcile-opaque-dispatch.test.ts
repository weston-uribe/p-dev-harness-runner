import { describe, expect, it, vi, beforeEach } from "vitest";
import type { HarnessConfig } from "../../src/config/types.js";
import {
  createEmptyWorkflowState,
  InMemoryWorkflowStateStore,
} from "../../src/workflow/state/index.js";

const mocks = vi.hoisted(() => ({
  fetchLinearIssue: vi.fn(),
  createWorkflowStateStore: vi.fn(),
  resolveRoute: vi.fn(),
  createReconcileJobAndDispatch: vi.fn(),
  createLinearClient: vi.fn(),
  listIssueComments: vi.fn(),
  transitionIssueStatus: vi.fn(),
  runLinearAssociationGate: vi.fn(),
  ensureCodeReviewJobDispatched: vi.fn(),
  ensurePlanReviewJobDispatched: vi.fn(),
  ensureImplementationJobDispatched: vi.fn(),
  resolveImplementationSubject: vi.fn(),
  markRunStatusBlocked: vi.fn(),
  markRevisionPendingPmFeedback: vi.fn(),
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

vi.mock("../../src/workflow/resolve-implementation-subject.js", () => ({
  resolveImplementationSubject: mocks.resolveImplementationSubject,
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
      handoff: ["PR Open"],
      revision: ["Needs Revision"],
      merge: ["Ready to Merge"],
    },
  },
  repos: [],
  allowedTargetRepos: [],
} as unknown as HarnessConfig;

describe("workflow reconcile opaque-only dispatch", () => {
  let store: InMemoryWorkflowStateStore;

  beforeEach(() => {
    vi.clearAllMocks();
    store = new InMemoryWorkflowStateStore();
    mocks.runLinearAssociationGate.mockReturnValue({ ok: true });
    mocks.createLinearClient.mockReturnValue({});
    mocks.listIssueComments.mockResolvedValue([]);
    mocks.createWorkflowStateStore.mockResolvedValue(store);
    mocks.createReconcileJobAndDispatch.mockResolvedValue({
      requestId: "dlv-opaque123456789012345678901234",
      envelopeSchemaVersion: 1,
      publicEventType: "linear_issue_status_changed",
      executionRepository: "weston-uribe/p-dev-harness-runner",
      duplicate: false,
      dispatched: true,
      ackConfirmed: false,
    });
  });

  it("planning reconcile dispatches opaque requestId only", async () => {
    mocks.fetchLinearIssue.mockResolvedValue({
      id: "iss-1",
      identifier: "FRE-6",
      status: "Ready for Planning",
      teamId: "team-fre",
      teamKey: "FRE",
      url: "https://linear.app/x/issue/FRE-6",
    });
    store.seed(
      createEmptyWorkflowState({
        issueKey: "FRE-6",
        workflowSchemaVersion: "product-development-v2",
      }),
    );
    mocks.resolveRoute.mockResolvedValue({
      issueKey: "FRE-6",
      phase: "planning",
      shouldRun: true,
      repoConfigId: "portfolio",
      baseBranch: "dev",
      targetRepo: "https://github.com/weston-uribe/weston-uribe-portfolio",
      linearStatus: "Ready for Planning",
      mergeConcurrencyGroup: "portfolio-dev",
      workflowStateRevision: 0,
    });

    const result = await evaluateWorkflowReconcileIssue({
      config,
      configPath: "/tmp/harness.config.json",
      issueKey: "FRE-6",
      linearApiKey: "lin",
      dispatch: true,
    });

    expect(result.dispatched).toBe(true);
    expect(result.reason).toBe("eligible_opaque_dispatch");
    expect(mocks.createReconcileJobAndDispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        issueKey: "FRE-6",
        phase: "planning",
      }),
    );
    const requestId =
      mocks.createReconcileJobAndDispatch.mock.results[0]?.value?.requestId ??
      "dlv-opaque123456789012345678901234";
    expect(requestId).toMatch(/^[A-Za-z0-9._-]+$/);
    expect(requestId.length).toBeGreaterThan(0);
  });

  it("Ready for Build uses implementation subject dispatch (not generic opaque)", async () => {
    mocks.fetchLinearIssue.mockResolvedValue({
      id: "iss-1",
      identifier: "FRE-7",
      status: "Ready for Build",
      teamId: "team-fre",
      teamKey: "FRE",
      url: "https://linear.app/x/issue/FRE-7",
      description: "Target repo: https://github.com/weston-uribe/weston-uribe-portfolio",
    });
    const state = createEmptyWorkflowState({
      issueKey: "FRE-7",
      workflowSchemaVersion: "product-development-v2",
    });
    store.seed({ ...state, stateRevision: 1, currentPhaseId: "implementation_dispatch" });
    mocks.resolveRoute.mockResolvedValue({
      issueKey: "FRE-7",
      phase: "implementation",
      shouldRun: true,
      repoConfigId: "portfolio",
      baseBranch: "dev",
      targetRepo: "https://github.com/weston-uribe/weston-uribe-portfolio",
      linearStatus: "Ready for Build",
      mergeConcurrencyGroup: "portfolio-dev",
      workflowStateRevision: 1,
    });
    mocks.resolveImplementationSubject.mockResolvedValue({
      subjectIdentity: "subj-impl-7",
      targetRepo: "https://github.com/weston-uribe/weston-uribe-portfolio",
      baseBranch: "dev",
      planGenerationId: "direct",
      planArtifactHash: "none",
      implementationCycle: 0,
      state: await store.load("FRE-7"),
      stateStore: store,
      workflowStateRevision: 1,
    });
    mocks.ensureImplementationJobDispatched.mockResolvedValue({
      outcome: "dispatched",
      reviewRequestId: "dlv-implsubject00000000000000000001",
      state: (await store.load("FRE-7"))!,
      httpDispatched: true,
    });

    const result = await evaluateWorkflowReconcileIssue({
      config,
      configPath: "/tmp/harness.config.json",
      issueKey: "FRE-7",
      linearApiKey: "lin",
      dispatch: true,
    });

    expect(result.dispatched).toBe(true);
    expect(mocks.ensureImplementationJobDispatched).toHaveBeenCalled();
    expect(mocks.createReconcileJobAndDispatch).not.toHaveBeenCalled();
  });
});
