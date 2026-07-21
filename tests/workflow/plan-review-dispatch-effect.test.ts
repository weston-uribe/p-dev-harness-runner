import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  createEmptyWorkflowState,
  InMemoryWorkflowStateStore,
} from "../../src/workflow/state/index.js";
import {
  buildPlanReviewDispatchEffectId,
  buildPlanReviewRequestId,
  ensurePlanReviewDispatchPending,
  ensurePlanReviewJobDispatched,
} from "../../src/workflow/plan-review-dispatch-effect.js";
import { getSideEffect } from "../../src/workflow/state/side-effects.js";
import { buildPlanReviewSubjectIdentity } from "../../src/workflow/subject-identities.js";
import { assertOpaqueDispatchPayload } from "../../src/workflow/job-request/dispatch-reconcile.js";

const mocks = vi.hoisted(() => ({
  createPlanReviewJobAndDispatch: vi.fn(),
  createGithubJobRequestStoreFromEnv: vi.fn(),
}));

vi.mock("../../src/workflow/job-request/dispatch-opaque.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../src/workflow/job-request/dispatch-opaque.js")
    >();
  return {
    ...actual,
    createPlanReviewJobAndDispatch: mocks.createPlanReviewJobAndDispatch,
  };
});

vi.mock("../../src/workflow/job-request/runtime-store.js", () => ({
  createGithubJobRequestStoreFromEnv: mocks.createGithubJobRequestStoreFromEnv,
}));

describe("plan_review_dispatch effect", () => {
  const issueKey = "FRE-6";
  const planGenerationId = "120aa5ff-005a-44e7-aa5a-0b4922d951b4";
  const planHash =
    "84076eff91fba2a0d2dd61d7da598f594d6362dd97186f1f3c7e4ef4dec56ba6";
  const subjectIdentity = buildPlanReviewSubjectIdentity({
    issueKey,
    planGenerationId,
    planHash,
    reviewCycle: 0,
  });
  const reviewRequestId = buildPlanReviewRequestId(subjectIdentity);
  const effectId = buildPlanReviewDispatchEffectId(subjectIdentity);

  let store: InMemoryWorkflowStateStore;

  beforeEach(() => {
    vi.clearAllMocks();
    store = new InMemoryWorkflowStateStore();
    const base = createEmptyWorkflowState({
      issueKey,
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
    mocks.createGithubJobRequestStoreFromEnv.mockResolvedValue({
      load: vi.fn().mockResolvedValue(null),
    });
    mocks.createPlanReviewJobAndDispatch.mockResolvedValue({
      requestId: reviewRequestId,
      envelopeSchemaVersion: 1,
      publicEventType: "linear_issue_status_changed",
      executionRepository: "weston-uribe/p-dev-harness-runner",
      duplicate: false,
      dispatched: true,
      ackConfirmed: false,
    });
  });

  afterEach(() => {
    delete process.env.GITHUB_DISPATCH_TOKEN;
    delete process.env.HARNESS_GITHUB_TOKEN;
  });

  it("pending effect persists before dispatch (crash boundary after step 3)", async () => {
    const state = (await store.load(issueKey))!;
    const pending = await ensurePlanReviewDispatchPending({
      store,
      issueKey,
      reviewSubjectIdentity: subjectIdentity,
      state,
    });
    expect(pending.planReviewSubjectIdentity).toBe(subjectIdentity);
    expect(getSideEffect(pending, effectId)?.status).toBe("pending");
    expect(getSideEffect(pending, effectId)?.kind).toBe("plan_review_dispatch");
  });

  it("creates one opaque pr-subject request and is idempotent", async () => {
    process.env.GITHUB_DISPATCH_TOKEN = "dispatch-present";
    const state = (await store.load(issueKey))!;
    const first = await ensurePlanReviewJobDispatched({
      store,
      issueKey,
      reviewSubjectIdentity: subjectIdentity,
      ownerGeneration: "planning-run-1",
      state,
    });
    expect(first.outcome).toBe("dispatched");
    expect(first.httpDispatched).toBe(true);
    expect(mocks.createPlanReviewJobAndDispatch).toHaveBeenCalledTimes(1);
    expect(assertOpaqueDispatchPayload({ requestId: first.reviewRequestId })).toBe(
      reviewRequestId,
    );
    expect(getSideEffect(first.state, effectId)?.status).toBe("dispatched");

    const second = await ensurePlanReviewJobDispatched({
      store,
      issueKey,
      reviewSubjectIdentity: subjectIdentity,
      ownerGeneration: "reconcile-2",
      state: first.state,
    });
    expect(second.outcome).toBe("already_dispatched");
    expect(mocks.createPlanReviewJobAndDispatch).toHaveBeenCalledTimes(1);
  });

  it("dispatch succeeds but persistence race still recovers via existing request", async () => {
    process.env.GITHUB_DISPATCH_TOKEN = "dispatch-present";
    mocks.createGithubJobRequestStoreFromEnv
      .mockResolvedValueOnce({ load: vi.fn().mockResolvedValue(null) })
      .mockResolvedValueOnce({
        load: vi.fn().mockResolvedValue({
          requestId: reviewRequestId,
          state: "pending",
        }),
      });

    const state = (await store.load(issueKey))!;
    // Force CAS loss after HTTP by concurrent bump.
    const originalCas = store.compareAndSet.bind(store);
    let calls = 0;
    store.compareAndSet = async (input) => {
      calls += 1;
      if (calls === 2) {
        // claim succeeded; force failure on mark-dispatched
        return false;
      }
      return originalCas(input);
    };

    const result = await ensurePlanReviewJobDispatched({
      store,
      issueKey,
      reviewSubjectIdentity: subjectIdentity,
      ownerGeneration: "planning-run-1",
      state,
    });
    expect(["dispatched", "request_already_present"]).toContain(result.outcome);
    expect(mocks.createPlanReviewJobAndDispatch).toHaveBeenCalledTimes(1);
  });

  it("rejects empty PAYLOAD_REQUEST_ID", () => {
    expect(() => assertOpaqueDispatchPayload({ requestId: "" })).toThrow(
      /opaque_dispatch_missing_request_id/,
    );
    expect(() =>
      assertOpaqueDispatchPayload({ requestId: "pr-subject:abc" }),
    ).toThrow(/opaque_dispatch_invalid_request_id/);
  });
});
