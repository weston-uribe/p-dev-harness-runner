import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  createEmptyWorkflowState,
  InMemoryWorkflowStateStore,
} from "../../src/workflow/state/index.js";
import { buildCodeReviewSubjectIdentity } from "../../src/workflow/subject-identities.js";

const mocks = vi.hoisted(() => ({
  ensureCodeReviewJobDispatched: vi.fn(),
  applyPhaseTransition: vi.fn(),
  postHandoffComment: vi.fn(),
  transitionIssueStatus: vi.fn(),
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

vi.mock("../../src/runner/workflow-transition.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/runner/workflow-transition.js")>();
  return {
    ...actual,
    applyPhaseTransition: mocks.applyPhaseTransition,
    resolveNextStatusName: actual.resolveNextStatusName,
  };
});

describe("handoff Code Review fresh-state contract", () => {
  const issueKey = "FRE-6";
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
    issueKey,
    prNumber: artifact.prNumber,
    headSha: artifact.headSha,
    diffHash: artifact.diffHash,
    reviewCycle: 0,
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("passes post-transition r8 state into ensureCodeReviewJobDispatched", async () => {
    const store = new InMemoryWorkflowStateStore();
    const base = createEmptyWorkflowState({
      issueKey,
      workflowSchemaVersion: "product-development-v2",
    });
    const r7 = {
      ...base,
      stateRevision: 7,
      currentPhaseId: "handoff",
      handoffSubjectIdentity: "c0265542191d6625a5f3389fe7cead44",
      latestImplementationArtifact: artifact,
      effectiveOptionalPhases: { planReview: true, codeReview: true },
    };
    store.seed(r7);

    const r8 = {
      ...r7,
      stateRevision: 8,
      currentPhaseId: "code_review",
      lastTransitionIdentity: "success:handoff:run",
    };

    mocks.applyPhaseTransition.mockResolvedValue({
      applyOk: true,
      statusName: "Code Review",
      reason: "ok",
      stateRevision: 8,
      state: r8,
      result: { reason: "handoff_success_to_code_review", bypass: null },
    });

    mocks.ensureCodeReviewJobDispatched.mockImplementation(async (input) => {
      expect(input.state.stateRevision).toBe(8);
      expect(input.state.currentPhaseId).toBe("code_review");
      expect(input.reviewSubjectIdentity).toBe(subject);
      return {
        outcome: "dispatched",
        reviewRequestId: "dlv-522c8b38361b4c426e3048a762c2c381",
        state: {
          ...input.state,
          stateRevision: 9,
          activeReviewSubjectIdentity: subject,
        },
        httpDispatched: true,
        claimLostRecoveries: 0,
      };
    });

    // Exercise the critical ordering helpers used by handoff:
    const applied = await mocks.applyPhaseTransition({
      store,
      issueKey,
      expectedStateRevision: 7,
    });
    const durable = applied.state;
    const dispatchResult = await mocks.ensureCodeReviewJobDispatched({
      store,
      issueKey,
      reviewSubjectIdentity: subject,
      ownerGeneration: "run",
      state: durable,
    });

    expect(dispatchResult.outcome).toBe("dispatched");
    expect(dispatchResult.reviewRequestId).toBe(
      "dlv-522c8b38361b4c426e3048a762c2c381",
    );
    expect(mocks.ensureCodeReviewJobDispatched).toHaveBeenCalledWith(
      expect.objectContaining({
        state: expect.objectContaining({ stateRevision: 8 }),
      }),
    );
  });

  it("treats claim_lost as not proven", async () => {
    const { isCodeReviewDispatchProven } = await import(
      "../../src/workflow/code-review-dispatch-effect.js"
    );
    expect(isCodeReviewDispatchProven("claim_lost")).toBe(false);
    expect(isCodeReviewDispatchProven("conflicting_subject")).toBe(false);
    expect(isCodeReviewDispatchProven("dispatched")).toBe(true);
    expect(isCodeReviewDispatchProven("already_dispatched")).toBe(true);
    expect(isCodeReviewDispatchProven("request_already_present")).toBe(true);
    expect(isCodeReviewDispatchProven("decision_already_accepted")).toBe(true);
    expect(isCodeReviewDispatchProven("reviewer_already_active")).toBe(true);
  });
});
