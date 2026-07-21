import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  createEmptyWorkflowState,
  InMemoryWorkflowStateStore,
} from "../../src/workflow/state/index.js";
import {
  buildCodeReviewDispatchEffectId,
  buildCodeReviewRequestId,
  ensureCodeReviewJobDispatched,
  isCodeReviewDispatchProven,
} from "../../src/workflow/code-review-dispatch-effect.js";
import {
  getSideEffect,
  markCodeReviewDispatchDispatched,
} from "../../src/workflow/state/side-effects.js";

const mocks = vi.hoisted(() => ({
  createCodeReviewJobAndDispatch: vi.fn(),
  createGithubJobRequestStoreFromEnv: vi.fn(),
}));

vi.mock("../../src/workflow/job-request/dispatch-opaque.js", () => ({
  createCodeReviewJobAndDispatch: mocks.createCodeReviewJobAndDispatch,
}));

vi.mock("../../src/workflow/job-request/runtime-store.js", () => ({
  createGithubJobRequestStoreFromEnv: mocks.createGithubJobRequestStoreFromEnv,
}));

describe("ensureCodeReviewJobDispatched claim_lost recovery", () => {
  const issueKey = "FRE-6";
  const reviewSubjectIdentity = "b4b3af1da3fa55b01518156ac87f3264";
  const reviewRequestId = buildCodeReviewRequestId(reviewSubjectIdentity);
  const effectId = buildCodeReviewDispatchEffectId(reviewSubjectIdentity);
  let store: InMemoryWorkflowStateStore;

  beforeEach(() => {
    vi.clearAllMocks();
    store = new InMemoryWorkflowStateStore();
    const base = createEmptyWorkflowState({
      issueKey,
      workflowSchemaVersion: "product-development-v2",
    });
    store.seed({
      ...base,
      stateRevision: 7,
      currentPhaseId: "code_review",
      handoffSubjectIdentity: "c0265542191d6625a5f3389fe7cead44",
      latestImplementationArtifact: {
        implementationGenerationId: "fb3158ee-080d-4d92-a690-3f133d01c562",
        targetRepository: "https://github.com/weston-uribe/weston-uribe-portfolio",
        prNumber: 53,
        prUrl: "https://github.com/weston-uribe/weston-uribe-portfolio/pull/53",
        headSha: "89186978332b1c9a45a25f4c1cdbb25919c03e2a",
        baseSha: "91a274d17d127fb5c6dec45750fa39af01cd4e91",
        diffHash:
          "519cd0f74fa03ad877f1ebf92eed77d7d1f2cf806bfee3a93599cc788b5185aa",
        builderRunId: "2026-07-21T02-40-54-909Z-FRE-6",
        acceptanceEvidenceId: null,
        testEvidenceId: null,
        workflowStateRevision: 6,
        createdAt: "2026-07-21T02:40:59.060Z",
        supersedesImplementationGenerationId: null,
        causedByReviewDecisionIdentity: null,
      },
    });
    mocks.createGithubJobRequestStoreFromEnv.mockResolvedValue({
      load: vi.fn().mockResolvedValue(null),
    });
    mocks.createCodeReviewJobAndDispatch.mockResolvedValue({
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
  });

  it("FRE-6 shape: stale r7 against store r8 reloads and dispatches once", async () => {
    process.env.GITHUB_DISPATCH_TOKEN = "dispatch-present";
    // Simulate applyPhaseTransition advancing store to r8 while caller holds r7.
    const r7 = (await store.load(issueKey))!;
    expect(r7.stateRevision).toBe(7);
    store.seed({
      ...r7,
      stateRevision: 8,
      currentPhaseId: "code_review",
      lastTransitionIdentity: "success:handoff:2026-07-21T02-40-54-909Z-FRE-6",
    });

    const result = await ensureCodeReviewJobDispatched({
      store,
      issueKey,
      reviewSubjectIdentity,
      ownerGeneration: "2026-07-21T02-40-54-909Z-FRE-6",
      state: r7,
      env: {
        GITHUB_DISPATCH_TOKEN: "dispatch-present",
        P_DEV_STATE_GITHUB_TOKEN: "state",
        P_DEV_JOB_REQUEST_REPOSITORY: "state/repo",
      },
    });

    expect(isCodeReviewDispatchProven(result.outcome)).toBe(true);
    expect(result.reviewRequestId).toBe(
      "cr-subject:b4b3af1da3fa55b01518156ac87f3264",
    );
    expect(result.claimLostRecoveries).toBeGreaterThanOrEqual(1);
    expect(mocks.createCodeReviewJobAndDispatch).toHaveBeenCalledTimes(1);
    expect(getSideEffect(result.state, effectId)?.status).toBe("dispatched");
    expect(result.state.activeReviewSubjectIdentity).toBe(reviewSubjectIdentity);
  });

  it("claim_lost when another actor completed same effect returns already_dispatched", async () => {
    process.env.GITHUB_DISPATCH_TOKEN = "dispatch-present";
    const stale = (await store.load(issueKey))!;
    const winner = await ensureCodeReviewJobDispatched({
      store,
      issueKey,
      reviewSubjectIdentity,
      ownerGeneration: "owner-1",
      state: stale,
      env: {
        GITHUB_DISPATCH_TOKEN: "dispatch-present",
        P_DEV_STATE_GITHUB_TOKEN: "state",
        P_DEV_JOB_REQUEST_REPOSITORY: "state/repo",
      },
    });
    expect(winner.outcome).toBe("dispatched");

    const loser = await ensureCodeReviewJobDispatched({
      store,
      issueKey,
      reviewSubjectIdentity,
      ownerGeneration: "owner-2",
      state: stale,
      env: {
        GITHUB_DISPATCH_TOKEN: "dispatch-present",
        P_DEV_STATE_GITHUB_TOKEN: "state",
        P_DEV_JOB_REQUEST_REPOSITORY: "state/repo",
      },
    });
    expect(loser.outcome).toBe("already_dispatched");
    expect(isCodeReviewDispatchProven(loser.outcome)).toBe(true);
    expect(mocks.createCodeReviewJobAndDispatch).toHaveBeenCalledTimes(1);
  });

  it("claim_lost with existing request returns request_already_present", async () => {
    process.env.GITHUB_DISPATCH_TOKEN = "dispatch-present";
    const stale = (await store.load(issueKey))!;
    // Advance store without the effect so first CAS claim fails.
    store.seed({ ...stale, stateRevision: stale.stateRevision + 1 });
    mocks.createGithubJobRequestStoreFromEnv.mockResolvedValue({
      load: vi.fn().mockResolvedValue({
        requestId: reviewRequestId,
        state: "accepted",
      }),
    });

    const result = await ensureCodeReviewJobDispatched({
      store,
      issueKey,
      reviewSubjectIdentity,
      ownerGeneration: "owner-1",
      state: stale,
      env: {
        GITHUB_DISPATCH_TOKEN: "dispatch-present",
        P_DEV_STATE_GITHUB_TOKEN: "state",
        P_DEV_JOB_REQUEST_REPOSITORY: "state/repo",
      },
    });

    expect(result.outcome).toBe("request_already_present");
    expect(mocks.createCodeReviewJobAndDispatch).not.toHaveBeenCalled();
  });

  it("conflicting activeReviewSubjectIdentity fails safely", async () => {
    process.env.GITHUB_DISPATCH_TOKEN = "dispatch-present";
    const state = (await store.load(issueKey))!;
    store.seed({
      ...state,
      activeReviewSubjectIdentity: "different-subject-aaaaaaaaaaaaaaaa",
    });
    const result = await ensureCodeReviewJobDispatched({
      store,
      issueKey,
      reviewSubjectIdentity,
      ownerGeneration: "owner-1",
      state: (await store.load(issueKey))!,
      env: {
        GITHUB_DISPATCH_TOKEN: "dispatch-present",
        P_DEV_STATE_GITHUB_TOKEN: "state",
        P_DEV_JOB_REQUEST_REPOSITORY: "state/repo",
      },
    });
    expect(result.outcome).toBe("conflicting_subject");
    expect(isCodeReviewDispatchProven(result.outcome)).toBe(false);
    expect(mocks.createCodeReviewJobAndDispatch).not.toHaveBeenCalled();
  });

  it("accepted decision is not rerun", async () => {
    const state = (await store.load(issueKey))!;
    store.seed({
      ...state,
      acceptedReviewSubjects: {
        [reviewSubjectIdentity]: "decision-abc",
      },
    });
    const result = await ensureCodeReviewJobDispatched({
      store,
      issueKey,
      reviewSubjectIdentity,
      ownerGeneration: "owner-1",
      state: (await store.load(issueKey))!,
      env: { GITHUB_DISPATCH_TOKEN: "dispatch-present" },
    });
    expect(result.outcome).toBe("decision_already_accepted");
    expect(mocks.createCodeReviewJobAndDispatch).not.toHaveBeenCalled();
  });

  it("active reviewer lease is reused without re-dispatch", async () => {
    const state = (await store.load(issueKey))!;
    store.seed({
      ...state,
      activeRunLease: {
        identity: `code_review:${reviewSubjectIdentity}`,
        ownerRunId: "run-reviewer",
        phaseId: "code_review",
        subjectIdentity: reviewSubjectIdentity,
        acquiredAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        heartbeatAt: new Date().toISOString(),
      },
    });
    const result = await ensureCodeReviewJobDispatched({
      store,
      issueKey,
      reviewSubjectIdentity,
      ownerGeneration: "owner-1",
      state: (await store.load(issueKey))!,
      env: { GITHUB_DISPATCH_TOKEN: "dispatch-present" },
    });
    expect(result.outcome).toBe("reviewer_already_active");
    expect(mocks.createCodeReviewJobAndDispatch).not.toHaveBeenCalled();
  });

  it("already dispatched effect is idempotent", async () => {
    const seeded = (await store.load(issueKey))!;
    const withDispatched = markCodeReviewDispatchDispatched(seeded, {
      identity: effectId,
      reviewRequestId,
    });
    store.seed({ ...withDispatched, stateRevision: seeded.stateRevision });
    const result = await ensureCodeReviewJobDispatched({
      store,
      issueKey,
      reviewSubjectIdentity,
      ownerGeneration: "owner-2",
      state: (await store.load(issueKey))!,
      env: { GITHUB_DISPATCH_TOKEN: "dispatch-present" },
    });
    expect(result.outcome).toBe("already_dispatched");
    expect(mocks.createCodeReviewJobAndDispatch).not.toHaveBeenCalled();
  });
});
