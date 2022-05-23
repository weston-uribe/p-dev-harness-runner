/**
 * FRE-5 regression: implementation complete, PR #50 exists, handoff subject set,
 * no review request initially. Broken path → configuration_error / missing_dispatch_token.
 * Fixed path → exactly one repository_dispatch and one review subject; no second
 * implementation agent or PR.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  createEmptyWorkflowState,
  InMemoryWorkflowStateStore,
} from "../../src/workflow/state/index.js";
import {
  buildCodeReviewDispatchEffectId,
  buildCodeReviewRequestId,
  ensureCodeReviewJobDispatched,
  MISSING_DISPATCH_TOKEN_MESSAGE,
} from "../../src/workflow/code-review-dispatch-effect.js";
import { classifyUnexpectedPhaseError } from "../../src/runner/classify-phase-error.js";
import { buildCodeReviewSubjectIdentity } from "../../src/workflow/subject-identities.js";
import { getSideEffect } from "../../src/workflow/state/side-effects.js";

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

describe("FRE-5 blocked review recovery regression", () => {
  const issueKey = "FRE-5";
  const artifact = {
    implementationGenerationId: "8d3bb8dd-8aac-426c-a036-9febc79abf9a",
    targetRepository: "https://github.com/weston-uribe/weston-uribe-portfolio",
    prNumber: 50,
    prUrl: "https://github.com/weston-uribe/weston-uribe-portfolio/pull/50",
    headSha: "cf71f1481c9b968219c58919839c0885fa2b8cc6",
    baseSha: "bd3f39261731969117bcbaa7327983d8ee6ce669",
    diffHash: "eae973d70791911cbc46dfa912bf57b6d2159a162697f5617fcbd53f15a2cf05",
    builderRunId: "2026-07-20T18-41-13-587Z-FRE-5",
    acceptanceEvidenceId: null,
    testEvidenceId: null,
    workflowStateRevision: 3,
    createdAt: "2026-07-20T18:41:17.263Z",
    supersedesImplementationGenerationId: null,
    causedByReviewDecisionIdentity: null,
  };

  const reviewSubjectIdentity = buildCodeReviewSubjectIdentity({
    issueKey,
    prNumber: artifact.prNumber,
    headSha: artifact.headSha,
    diffHash: artifact.diffHash,
    reviewCycle: 0,
  });
  const reviewRequestId = buildCodeReviewRequestId(reviewSubjectIdentity);
  const effectId = buildCodeReviewDispatchEffectId(reviewSubjectIdentity);

  let store: InMemoryWorkflowStateStore;

  beforeEach(() => {
    vi.clearAllMocks();
    store = new InMemoryWorkflowStateStore();
    const base = createEmptyWorkflowState({
      issueKey,
      workflowSchemaVersion: "product-development-v2",
      enabledOptionalPhases: { planReview: false, codeReview: true },
      effectiveOptionalPhases: { planReview: false, codeReview: true },
    });
    store.seed({
      ...base,
      stateRevision: 3,
      currentPhaseId: "code_review",
      handoffSubjectIdentity: "1f30fae5d07d0d31f067d83fbf4f510d",
      latestImplementationArtifact: artifact,
      activeReviewSubjectIdentity: null,
      acceptedReviewSubjects: {},
      completedPhaseIdentities: ["handoff:2026-07-20T18-41-13-587Z-FRE-5"],
      sideEffects: [
        {
          identity: "build_complete_marker:1f30fae5d07d0d31f067d83fbf4f510d",
          kind: "build_complete_marker",
          status: "completed",
          createdAt: "2026-07-20T18:41:17.264Z",
          completedAt: "2026-07-20T18:41:18.428Z",
        },
        {
          identity:
            "linear_status_transition:1f30fae5d07d0d31f067d83fbf4f510d:code_review",
          kind: "linear_status_transition",
          status: "pending",
          createdAt: "2026-07-20T18:41:17.264Z",
        },
      ],
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
    delete process.env.HARNESS_GITHUB_TOKEN;
    delete process.env.GITHUB_TOKEN;
  });

  it("broken production path: only GITHUB_TOKEN → configuration_error / missing_dispatch_token", async () => {
    const state = (await store.load(issueKey))!;
    const result = await ensureCodeReviewJobDispatched({
      store,
      issueKey,
      reviewSubjectIdentity,
      ownerGeneration: "29768346554",
      state,
      env: {
        GITHUB_TOKEN: "github-present",
        P_DEV_STATE_GITHUB_TOKEN: "state-present",
        P_DEV_JOB_REQUEST_REPOSITORY: "weston-uribe/p-dev-harness-state",
      },
    });

    expect(result.outcome).toBe("missing_dispatch_token");
    expect(mocks.createCodeReviewJobAndDispatch).not.toHaveBeenCalled();
    expect(getSideEffect(result.state, effectId)?.status).toBe("blocked");
    expect(
      classifyUnexpectedPhaseError(new Error(MISSING_DISPATCH_TOKEN_MESSAGE)),
    ).toBe("configuration_error");

    // Implementation evidence preserved — no second PR / generation.
    expect(result.state.latestImplementationArtifact?.prNumber).toBe(50);
    expect(result.state.latestImplementationArtifact?.implementationGenerationId).toBe(
      "8d3bb8dd-8aac-426c-a036-9febc79abf9a",
    );
    expect(result.state.handoffSubjectIdentity).toBe(
      "1f30fae5d07d0d31f067d83fbf4f510d",
    );
    expect(result.state.activeReviewSubjectIdentity).toBeNull();
  });

  it("corrected path: GITHUB_DISPATCH_TOKEN alias → exactly one dispatch and one review subject", async () => {
    const state = (await store.load(issueKey))!;
    const first = await ensureCodeReviewJobDispatched({
      store,
      issueKey,
      reviewSubjectIdentity,
      ownerGeneration: "reconcile:FRE-5:1",
      state,
      env: {
        GITHUB_DISPATCH_TOKEN: "dispatch-present",
        P_DEV_STATE_GITHUB_TOKEN: "state-present",
        P_DEV_JOB_REQUEST_REPOSITORY: "weston-uribe/p-dev-harness-state",
      },
    });

    expect(first.outcome).toBe("dispatched");
    expect(first.httpDispatched).toBe(true);
    expect(mocks.createCodeReviewJobAndDispatch).toHaveBeenCalledTimes(1);
    expect(first.state.activeReviewSubjectIdentity).toBe(reviewSubjectIdentity);
    expect(getSideEffect(first.state, effectId)?.status).toBe("dispatched");
    expect(getSideEffect(first.state, effectId)?.reviewRequestId).toBe(
      reviewRequestId,
    );

    // Second reconcile / owner must not create another dispatch or PR.
    mocks.createGithubJobRequestStoreFromEnv.mockResolvedValue({
      load: vi.fn().mockResolvedValue({
        requestId: reviewRequestId,
        state: "accepted",
        phase: "code_review",
        triggerSource: "harness_code_review_handoff",
      }),
    });
    const second = await ensureCodeReviewJobDispatched({
      store,
      issueKey,
      reviewSubjectIdentity,
      ownerGeneration: "reconcile:FRE-5:2",
      state: first.state,
      env: {
        GITHUB_DISPATCH_TOKEN: "dispatch-present",
        P_DEV_STATE_GITHUB_TOKEN: "state-present",
        P_DEV_JOB_REQUEST_REPOSITORY: "weston-uribe/p-dev-harness-state",
      },
    });

    expect(
      second.outcome === "already_dispatched" ||
        second.outcome === "request_already_present",
    ).toBe(true);
    expect(second.httpDispatched).toBe(false);
    expect(mocks.createCodeReviewJobAndDispatch).toHaveBeenCalledTimes(1);
    expect(second.state.latestImplementationArtifact?.prNumber).toBe(50);
    expect(second.state.handoffSubjectIdentity).toBe(
      "1f30fae5d07d0d31f067d83fbf4f510d",
    );
  });

  it("does not invent a second implementation generation or PR number", async () => {
    const state = (await store.load(issueKey))!;
    const result = await ensureCodeReviewJobDispatched({
      store,
      issueKey,
      reviewSubjectIdentity,
      ownerGeneration: "reconcile:FRE-5:1",
      state,
      env: {
        HARNESS_GITHUB_TOKEN: "harness-present",
        P_DEV_STATE_GITHUB_TOKEN: "state-present",
        P_DEV_JOB_REQUEST_REPOSITORY: "weston-uribe/p-dev-harness-state",
      },
    });

    expect(result.outcome).toBe("dispatched");
    expect(result.state.latestImplementationArtifact).toEqual(artifact);
    expect(result.state.completedPhaseIdentities).toContain(
      "handoff:2026-07-20T18-41-13-587Z-FRE-5",
    );
  });
});
