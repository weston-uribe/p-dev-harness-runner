import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  createEmptyWorkflowState,
  InMemoryWorkflowStateStore,
} from "../../src/workflow/state/index.js";
import {
  buildCodeReviewDispatchEffectId,
  buildCodeReviewRequestId,
  ensureCodeReviewJobDispatched,
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
  redispatchJobRequestById: vi.fn().mockResolvedValue({
    requestId: "cr-subject:subject-abc",
    dispatched: true,
  }),
}));

vi.mock("../../src/workflow/job-request/runtime-store.js", () => ({
  createGithubJobRequestStoreFromEnv: mocks.createGithubJobRequestStoreFromEnv,
}));

describe("ensureCodeReviewJobDispatched", () => {
  const issueKey = "FRE-5";
  const reviewSubjectIdentity = "subject-abc";
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
      stateRevision: 1,
      currentPhaseId: "code_review",
      latestImplementationArtifact: {
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
        workflowStateRevision: 1,
        createdAt: "2026-07-20T18:41:17.263Z",
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
    delete process.env.HARNESS_GITHUB_TOKEN;
    delete process.env.GITHUB_TOKEN;
  });

  it("dispatches once and persists dispatched effect", async () => {
    process.env.GITHUB_DISPATCH_TOKEN = "dispatch-present";
    const state = (await store.load(issueKey))!;
    const result = await ensureCodeReviewJobDispatched({
      store,
      issueKey,
      reviewSubjectIdentity,
      ownerGeneration: "owner-1",
      state,
      env: {
        GITHUB_DISPATCH_TOKEN: "dispatch-present",
        P_DEV_STATE_GITHUB_TOKEN: "state-present",
        P_DEV_JOB_REQUEST_REPOSITORY: "state/repo",
      },
    });

    expect(result.outcome).toBe("dispatched");
    expect(result.httpDispatched).toBe(true);
    expect(mocks.createCodeReviewJobAndDispatch).toHaveBeenCalledTimes(1);
    const effect = getSideEffect(result.state, effectId);
    expect(effect?.status).toBe("dispatched");
    expect(effect?.reviewRequestId).toBe(reviewRequestId);
  });

  it("blocks with missing_dispatch_token when no dispatch credential", async () => {
    const state = (await store.load(issueKey))!;
    const result = await ensureCodeReviewJobDispatched({
      store,
      issueKey,
      reviewSubjectIdentity,
      ownerGeneration: "owner-1",
      state,
      env: {
        GITHUB_TOKEN: "github-present",
        P_DEV_STATE_GITHUB_TOKEN: "state-present",
        P_DEV_JOB_REQUEST_REPOSITORY: "state/repo",
      },
    });

    expect(result.outcome).toBe("missing_dispatch_token");
    expect(mocks.createCodeReviewJobAndDispatch).not.toHaveBeenCalled();
    const effect = getSideEffect(result.state, effectId);
    expect(effect?.status).toBe("blocked");
    expect(effect?.blockedReason).toBe("missing_dispatch_token");
  });

  it("skips HTTP when deterministic request already exists", async () => {
    process.env.GITHUB_DISPATCH_TOKEN = "dispatch-present";
    mocks.createGithubJobRequestStoreFromEnv.mockResolvedValue({
      load: vi.fn().mockResolvedValue({
        requestId: reviewRequestId,
        state: "accepted",
      }),
    });
    const state = (await store.load(issueKey))!;
    const result = await ensureCodeReviewJobDispatched({
      store,
      issueKey,
      reviewSubjectIdentity,
      ownerGeneration: "owner-1",
      state,
      env: {
        GITHUB_DISPATCH_TOKEN: "dispatch-present",
        P_DEV_STATE_GITHUB_TOKEN: "state-present",
        P_DEV_JOB_REQUEST_REPOSITORY: "state/repo",
      },
    });

    expect(result.outcome).toBe("request_already_present");
    expect(result.httpDispatched).toBe(false);
    expect(mocks.createCodeReviewJobAndDispatch).not.toHaveBeenCalled();
    expect(getSideEffect(result.state, effectId)?.status).toBe("dispatched");
  });

  it("treats already-dispatched effect as durable without re-dispatch", async () => {
    process.env.GITHUB_DISPATCH_TOKEN = "dispatch-present";
    const seeded = (await store.load(issueKey))!;
    const withDispatched = markCodeReviewDispatchDispatched(seeded, {
      identity: effectId,
      reviewRequestId,
    });
    store.seed({ ...withDispatched, stateRevision: seeded.stateRevision });
    const state = (await store.load(issueKey))!;
    const result = await ensureCodeReviewJobDispatched({
      store,
      issueKey,
      reviewSubjectIdentity,
      ownerGeneration: "owner-2",
      state,
      env: {
        GITHUB_DISPATCH_TOKEN: "dispatch-present",
        P_DEV_STATE_GITHUB_TOKEN: "state-present",
        P_DEV_JOB_REQUEST_REPOSITORY: "state/repo",
      },
    });

    expect(result.outcome).toBe("already_dispatched");
    expect(mocks.createCodeReviewJobAndDispatch).not.toHaveBeenCalled();
  });

  it("recovers when HTTP dispatch succeeds but post-dispatch CAS fails", async () => {
    process.env.GITHUB_DISPATCH_TOKEN = "dispatch-present";
    const state = (await store.load(issueKey))!;
    let casCount = 0;
    const originalCas = store.compareAndSet.bind(store);
    store.compareAndSet = async (input) => {
      casCount += 1;
      // First CAS (claim) succeeds; second CAS (mark dispatched) fails.
      if (casCount === 2) {
        return null;
      }
      return originalCas(input);
    };
    mocks.createGithubJobRequestStoreFromEnv
      .mockResolvedValueOnce({
        load: vi.fn().mockResolvedValue(null),
      })
      .mockResolvedValueOnce({
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
      state,
      env: {
        GITHUB_DISPATCH_TOKEN: "dispatch-present",
        P_DEV_STATE_GITHUB_TOKEN: "state-present",
        P_DEV_JOB_REQUEST_REPOSITORY: "state/repo",
      },
    });

    expect(mocks.createCodeReviewJobAndDispatch).toHaveBeenCalledTimes(1);
    expect(
      result.outcome === "request_already_present" ||
        result.outcome === "dispatched",
    ).toBe(true);
  });

  it("two owners racing: loser gets claim_lost and does not dispatch", async () => {
    process.env.GITHUB_DISPATCH_TOKEN = "dispatch-present";
    const state = (await store.load(issueKey))!;
    const first = await ensureCodeReviewJobDispatched({
      store,
      issueKey,
      reviewSubjectIdentity,
      ownerGeneration: "owner-1",
      state,
      env: {
        GITHUB_DISPATCH_TOKEN: "dispatch-present",
        P_DEV_STATE_GITHUB_TOKEN: "state-present",
        P_DEV_JOB_REQUEST_REPOSITORY: "state/repo",
      },
    });
    expect(first.outcome).toBe("dispatched");

    // Second owner starts from pre-dispatch snapshot — claim should lose or see durable.
    const second = await ensureCodeReviewJobDispatched({
      store,
      issueKey,
      reviewSubjectIdentity,
      ownerGeneration: "owner-2",
      state,
      env: {
        GITHUB_DISPATCH_TOKEN: "dispatch-present",
        P_DEV_STATE_GITHUB_TOKEN: "state-present",
        P_DEV_JOB_REQUEST_REPOSITORY: "state/repo",
      },
    });
    expect(
      second.outcome === "already_dispatched" ||
        second.outcome === "claim_lost" ||
        second.outcome === "request_already_present",
    ).toBe(true);
    expect(mocks.createCodeReviewJobAndDispatch).toHaveBeenCalledTimes(1);
  });
});
