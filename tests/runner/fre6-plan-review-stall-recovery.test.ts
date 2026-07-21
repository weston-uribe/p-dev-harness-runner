/**
 * FRE-6 regression: planning complete, Plan Review status, plan artifact present,
 * no plan_review_dispatch initially. Fixed path → exactly one opaque pr-subject
 * dispatch; planner/generation/hash preserved; second call idempotent.
 */
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
  MISSING_PLAN_REVIEW_DISPATCH_TOKEN_MESSAGE,
} from "../../src/workflow/plan-review-dispatch-effect.js";
import { buildPlanReviewSubjectIdentity } from "../../src/workflow/subject-identities.js";
import { getSideEffect } from "../../src/workflow/state/side-effects.js";
import { classifyUnexpectedPhaseError } from "../../src/runner/classify-phase-error.js";
import { formatPlanningComment } from "../../src/linear/comments.js";

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

describe("FRE-6 plan review stall recovery regression", () => {
  const issueKey = "FRE-6";
  const planGenerationId = "120aa5ff-005a-44e7-aa5a-0b4922d951b4";
  const planHash =
    "84076eff91fba2a0d2dd61d7da598f594d6362dd97186f1f3c7e4ef4dec56ba6";
  const plannerRunId = "2026-07-21T00-14-47-057Z-FRE-6";
  const plannerAgentId = "bc-cc3e54c4-7395-4975-b934-1e50fe2e4c38";
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
      enabledOptionalPhases: { planReview: true, codeReview: true },
      effectiveOptionalPhases: { planReview: true, codeReview: false },
    });
    store.seed({
      ...base,
      stateRevision: 1,
      currentPhaseId: "plan_review",
      lastTransitionAt: "2026-07-21T00:19:00.029Z",
      completedPhaseIdentities: [`planning:${plannerRunId}`],
      latestPlanArtifact: {
        planGenerationId,
        planArtifactHash: planHash,
        plannerRunId,
        promptContractVersion: "planning@1",
        workflowStateRevision: 1,
        createdAt: "2026-07-21T00:18:59.522Z",
        supersedesPlanGenerationId: null,
        causedByReviewDecisionIdentity: null,
      },
      sideEffects: [],
      planReviewSubjectIdentity: null,
      planReviewerAgentId: null,
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
    delete process.env.GITHUB_TOKEN;
  });

  it("broken path: only GITHUB_TOKEN → missing_dispatch_token; plan preserved", async () => {
    const state = (await store.load(issueKey))!;
    const result = await ensurePlanReviewJobDispatched({
      store,
      issueKey,
      reviewSubjectIdentity: subjectIdentity,
      ownerGeneration: plannerRunId,
      state,
      env: {
        GITHUB_TOKEN: "github-present",
        P_DEV_STATE_GITHUB_TOKEN: "state-present",
        P_DEV_JOB_REQUEST_REPOSITORY: "weston-uribe/p-dev-harness-state",
      },
    });

    expect(result.outcome).toBe("missing_dispatch_token");
    expect(mocks.createPlanReviewJobAndDispatch).not.toHaveBeenCalled();
    expect(getSideEffect(result.state, effectId)?.status).toBe("blocked");
    expect(
      classifyUnexpectedPhaseError(
        new Error(MISSING_PLAN_REVIEW_DISPATCH_TOKEN_MESSAGE),
      ),
    ).toBe("configuration_error");
    expect(result.state.latestPlanArtifact?.planGenerationId).toBe(
      planGenerationId,
    );
    expect(result.state.latestPlanArtifact?.planArtifactHash).toBe(planHash);
    expect(result.state.planReviewerAgentId).toBeNull();
  });

  it("crash-safe order: pending before dispatch; one reviewer request", async () => {
    process.env.GITHUB_DISPATCH_TOKEN = "dispatch-present";
    let state = (await store.load(issueKey))!;
    state = await ensurePlanReviewDispatchPending({
      store,
      issueKey,
      reviewSubjectIdentity: subjectIdentity,
      state,
    });
    expect(getSideEffect(state, effectId)?.status).toBe("pending");

    const first = await ensurePlanReviewJobDispatched({
      store,
      issueKey,
      reviewSubjectIdentity: subjectIdentity,
      ownerGeneration: `reconcile:${issueKey}:1`,
      state,
    });
    expect(first.outcome).toBe("dispatched");
    expect(mocks.createPlanReviewJobAndDispatch).toHaveBeenCalledTimes(1);
    expect(first.state.planReviewSubjectIdentity).toBe(subjectIdentity);
    expect(first.state.latestPlanArtifact?.plannerRunId).toBe(plannerRunId);

    // Race: planning completion + scheduled reconcile
    const raced = await Promise.all([
      ensurePlanReviewJobDispatched({
        store,
        issueKey,
        reviewSubjectIdentity: subjectIdentity,
        ownerGeneration: "planning-still-running",
        state: first.state,
      }),
      ensurePlanReviewJobDispatched({
        store,
        issueKey,
        reviewSubjectIdentity: subjectIdentity,
        ownerGeneration: "reconcile-race",
        state: first.state,
      }),
    ]);
    expect(
      raced.every((r) =>
        ["already_dispatched", "request_already_present", "claim_lost"].includes(
          r.outcome,
        ),
      ),
    ).toBe(true);
    expect(mocks.createPlanReviewJobAndDispatch).toHaveBeenCalledTimes(1);
  });

  it("planning comment announces Plan Review when effective", () => {
    const body = formatPlanningComment(
      "Do the thing",
      {
        runId: plannerRunId,
        targetRepo: "https://github.com/weston-uribe/weston-uribe-portfolio",
        orchestratorMarker: "harness-orchestrator-v1",
        promptVersion: "planning@1",
        cursorAgentId: plannerAgentId,
        planGenerationId,
        planArtifactHash: planHash,
      },
      { planReviewNext: true },
    );
    expect(body).toContain("Plan Review will start automatically");
    expect(body).not.toContain("Implementation will start automatically");
  });

  it("completed decision subject is not redispatched", async () => {
    process.env.GITHUB_DISPATCH_TOKEN = "dispatch-present";
    const state = (await store.load(issueKey))!;
    store.seed({
      ...state,
      stateRevision: 2,
      planReviewSubjectIdentity: subjectIdentity,
      acceptedReviewSubjects: {
        [subjectIdentity]: "decision-abc",
      },
      sideEffects: [
        {
          identity: effectId,
          kind: "plan_review_dispatch",
          status: "completed",
          createdAt: "2026-07-21T00:19:00.000Z",
          completedAt: "2026-07-21T00:25:00.000Z",
          reviewRequestId,
        },
      ],
    });
    const result = await ensurePlanReviewJobDispatched({
      store,
      issueKey,
      reviewSubjectIdentity: subjectIdentity,
      ownerGeneration: "reconcile-after-decision",
      state: (await store.load(issueKey))!,
    });
    expect(result.outcome).toBe("already_dispatched");
    expect(mocks.createPlanReviewJobAndDispatch).not.toHaveBeenCalled();
  });
});
