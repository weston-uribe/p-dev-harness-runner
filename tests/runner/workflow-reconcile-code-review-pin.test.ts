import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  createEmptyWorkflowState,
  InMemoryWorkflowStateStore,
} from "../../src/workflow/state/index.js";
import type { HarnessConfig } from "../../src/config/types.js";
import { buildCodeReviewSubjectIdentity } from "../../src/workflow/subject-identities.js";
import { buildCodeReviewRequestId } from "../../src/workflow/code-review-dispatch-effect.js";

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

import { evaluateWorkflowReconcileIssue } from "../../src/runner/workflow-reconcile.js";

const artifact = {
  implementationGenerationId: "fb3158ee-080d-4d92-a690-3f133d01c562",
  targetRepository: "https://github.com/weston-uribe/weston-uribe-portfolio",
  prNumber: 53,
  prUrl: "https://github.com/weston-uribe/weston-uribe-portfolio/pull/53",
  headSha: "89186978332b1c9a45a25f4c1cdbb25919c03e2a",
  baseSha: "91a274d17d127fb5c6dec45750fa39af01cd4e91",
  diffHash: "519cd0f74fa03ad877f1ebf92eed77d7d1f2cf806bfee3a93599cc788b5185aa",
  builderRunId: "2026-07-21T02-40-54-909Z-FRE-6",
  acceptanceEvidenceId: null,
  testEvidenceId: null,
  workflowStateRevision: 6,
  createdAt: "2026-07-21T02:40:59.060Z",
  supersedesImplementationGenerationId: null,
  causedByReviewDecisionIdentity: null,
};

const subject = buildCodeReviewSubjectIdentity({
  issueKey: "FRE-6",
  prNumber: 53,
  headSha: artifact.headSha,
  diffHash: artifact.diffHash,
  reviewCycle: 0,
});

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
          teamId: "abe28dd5-59a4-49b6-a867-1301a9ba5185",
          teamKey: "TT",
          projectId: "proj-tt",
        },
        {
          workspaceId: "ws",
          teamId: "8f9c1260-364b-4d3e-9aa2-0391767d5204",
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

describe("pinned Code Review reconcile", () => {
  let store: InMemoryWorkflowStateStore;

  beforeEach(() => {
    vi.clearAllMocks();
    store = new InMemoryWorkflowStateStore();
    const base = createEmptyWorkflowState({
      issueKey: "FRE-6",
      workflowSchemaVersion: "product-development-v2",
    });
    store.seed({
      ...base,
      stateRevision: 8,
      currentPhaseId: "code_review",
      handoffSubjectIdentity: "c0265542191d6625a5f3389fe7cead44",
      latestImplementationArtifact: artifact,
      sideEffects: [
        {
          identity:
            "build_complete_marker:c0265542191d6625a5f3389fe7cead44",
          kind: "build_complete_marker",
          status: "completed",
          createdAt: "2026-07-21T02:40:59.060Z",
          completedAt: "2026-07-21T02:41:00.377Z",
        },
      ],
    });
    mocks.createWorkflowStateStore.mockResolvedValue(store);
    mocks.runLinearAssociationGate.mockReturnValue({ ok: true });
    mocks.resolveRoute.mockResolvedValue({
      shouldRun: false,
      phase: "none",
      reconcileReason: "not_eligible",
      workflowStateRevision: 8,
    });
    mocks.createLinearClient.mockReturnValue({});
    mocks.listIssueComments.mockResolvedValue([]);
    mocks.fetchLinearIssue.mockResolvedValue({
      id: "issue-fre-6",
      identifier: "FRE-6",
      title: "Update card",
      description: "",
      status: "Code Review",
      projectName: "harness",
      teamName: "fresh p-dev linear team",
      teamKey: "FRE",
      teamId: "8f9c1260-364b-4d3e-9aa2-0391767d5204",
      url: "https://linear.app/example/issue/FRE-6",
    });
  });

  it("dry-run pin reports one code_review action and deterministic cr-subject", async () => {
    const result = await evaluateWorkflowReconcileIssue({
      config,
      configPath: "/tmp/harness.config.json",
      issueKey: "FRE-6",
      linearApiKey: "lin",
      dryRun: true,
      phase: "code_review",
      subject,
    });

    expect(result.phase).toBe("code_review");
    expect(result.action).toBe("dispatch");
    expect(result.codeReviewSubjectIdentity).toBe(subject);
    expect(result.codeReviewRequestId).toBe(buildCodeReviewRequestId(subject));
    expect(result.codeReviewRequestId).toBe(
      "dlv-522c8b38361b4c426e3048a762c2c381",
    );
    expect(result.dispatched).toBe(false);
    expect(mocks.ensureCodeReviewJobDispatched).not.toHaveBeenCalled();
  });

  it("live pin dispatches once and reuses association candidate path", async () => {
    mocks.ensureCodeReviewJobDispatched.mockResolvedValue({
      outcome: "dispatched",
      reviewRequestId: buildCodeReviewRequestId(subject),
      state: (await store.load("FRE-6"))!,
      httpDispatched: true,
      claimLostRecoveries: 0,
    });

    const result = await evaluateWorkflowReconcileIssue({
      config,
      configPath: "/tmp/harness.config.json",
      issueKey: "FRE-6",
      linearApiKey: "lin",
      dispatch: true,
      phase: "code_review",
      subject,
    });

    expect(result.phase).toBe("code_review");
    expect(result.dispatched).toBe(true);
    expect(result.codeReviewSubjectIdentity).toBe(subject);
    expect(mocks.ensureCodeReviewJobDispatched).toHaveBeenCalledTimes(1);
    expect(mocks.createWorkflowStateStore).toHaveBeenCalled();
  });

  it("idempotent pin after dispatch does not re-dispatch", async () => {
    const { markCodeReviewDispatchDispatched } = await import(
      "../../src/workflow/state/side-effects.js"
    );
    const { buildCodeReviewDispatchEffectId } = await import(
      "../../src/workflow/code-review-dispatch-effect.js"
    );
    const current = (await store.load("FRE-6"))!;
    const effectId = buildCodeReviewDispatchEffectId(subject);
    store.seed(
      markCodeReviewDispatchDispatched(
        {
          ...current,
          activeReviewSubjectIdentity: subject,
        },
        {
          identity: effectId,
          reviewRequestId: buildCodeReviewRequestId(subject),
        },
      ),
    );

    const result = await evaluateWorkflowReconcileIssue({
      config,
      configPath: "/tmp/harness.config.json",
      issueKey: "FRE-6",
      linearApiKey: "lin",
      dispatch: true,
      phase: "code_review",
      subject,
    });

    expect(result.action).toBe("noop");
    expect(result.reason).toBe("pinned_code_review_already_dispatched");
    expect(mocks.ensureCodeReviewJobDispatched).not.toHaveBeenCalled();
  });
});
