import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  createEmptyWorkflowState,
  InMemoryWorkflowStateStore,
} from "../../src/workflow/state/index.js";
import {
  buildImplementationDispatchEffectId,
  buildImplementationRequestId,
  ensureImplementationDispatchPending,
  ensureImplementationJobDispatched,
} from "../../src/workflow/implementation-dispatch-effect.js";
import { getSideEffect } from "../../src/workflow/state/side-effects.js";
import { buildImplementationSubjectIdentity } from "../../src/workflow/subject-identities.js";

const mocks = vi.hoisted(() => ({
  createImplementationJobAndDispatch: vi.fn(),
  createGithubJobRequestStoreFromEnv: vi.fn(),
}));

vi.mock("../../src/workflow/job-request/dispatch-opaque.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../src/workflow/job-request/dispatch-opaque.js")
    >();
  return {
    ...actual,
    createImplementationJobAndDispatch: mocks.createImplementationJobAndDispatch,
  };
});

vi.mock("../../src/workflow/job-request/runtime-store.js", () => ({
  createGithubJobRequestStoreFromEnv: mocks.createGithubJobRequestStoreFromEnv,
}));

describe("implementation_dispatch effect", () => {
  const issueKey = "FRE-6";
  const subjectIdentity = buildImplementationSubjectIdentity({
    issueKey,
    targetRepo: "https://github.com/weston-uribe/weston-uribe-portfolio",
    baseBranch: "dev",
    planGenerationId: "120aa5ff-005a-44e7-aa5a-0b4922d951b4",
    planArtifactHash:
      "84076eff91fba2a0d2dd61d7da598f594d6362dd97186f1f3c7e4ef4dec56ba6",
    implementationCycle: 0,
  });
  const reviewRequestId = buildImplementationRequestId(subjectIdentity);
  const effectId = buildImplementationDispatchEffectId(subjectIdentity);

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
      currentPhaseId: "implementation_dispatch",
      latestPlanArtifact: {
        planGenerationId: "120aa5ff-005a-44e7-aa5a-0b4922d951b4",
        planArtifactHash:
          "84076eff91fba2a0d2dd61d7da598f594d6362dd97186f1f3c7e4ef4dec56ba6",
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
    mocks.createImplementationJobAndDispatch.mockResolvedValue({
      requestId: reviewRequestId,
      envelopeSchemaVersion: 1,
      publicEventType: "linear_issue_status_changed",
      executionRepository: "weston-uribe/p-dev-harness-runner",
      duplicate: false,
      dispatched: true,
      ackConfirmed: false,
    });
    process.env.GITHUB_DISPATCH_TOKEN = "test-token";
  });

  afterEach(() => {
    delete process.env.GITHUB_DISPATCH_TOKEN;
    delete process.env.HARNESS_GITHUB_TOKEN;
  });

  it("pending effect persists before dispatch", async () => {
    const state = (await store.load(issueKey))!;
    const pending = await ensureImplementationDispatchPending({
      store,
      issueKey,
      implementationSubjectIdentity: subjectIdentity,
      state,
    });
    expect(pending.implementationSubjectIdentity).toBe(subjectIdentity);
    const effect = getSideEffect(pending, effectId);
    expect(effect?.kind).toBe("implementation_dispatch");
    expect(effect?.status).toBe("pending");
    expect(effect?.reviewRequestId).toBe(reviewRequestId);
  });

  it("dispatches once then returns already_dispatched", async () => {
    const state = (await store.load(issueKey))!;
    const first = await ensureImplementationJobDispatched({
      store,
      issueKey,
      implementationSubjectIdentity: subjectIdentity,
      ownerGeneration: "gen-1",
      state,
    });
    expect(first.outcome).toBe("dispatched");
    expect(first.httpDispatched).toBe(true);
    expect(mocks.createImplementationJobAndDispatch).toHaveBeenCalledTimes(1);

    const second = await ensureImplementationJobDispatched({
      store,
      issueKey,
      implementationSubjectIdentity: subjectIdentity,
      ownerGeneration: "gen-2",
      state: first.state,
    });
    expect(second.outcome).toBe("already_dispatched");
    expect(second.httpDispatched).toBe(false);
    expect(mocks.createImplementationJobAndDispatch).toHaveBeenCalledTimes(1);
  });

  it("returns request_already_present without HTTP when envelope exists", async () => {
    mocks.createGithubJobRequestStoreFromEnv.mockResolvedValue({
      load: vi.fn().mockResolvedValue({
        requestId: reviewRequestId,
        state: "pending",
      }),
    });
    const state = (await store.load(issueKey))!;
    const result = await ensureImplementationJobDispatched({
      store,
      issueKey,
      implementationSubjectIdentity: subjectIdentity,
      ownerGeneration: "gen-1",
      state,
    });
    expect(result.outcome).toBe("request_already_present");
    expect(result.httpDispatched).toBe(false);
    expect(mocks.createImplementationJobAndDispatch).not.toHaveBeenCalled();
  });

  it("no-ops when builder already present", async () => {
    const state = {
      ...(await store.load(issueKey))!,
      builderAgentId: "bc-existing",
      implementationSubjectIdentity: subjectIdentity,
    };
    store.seed(state);
    const result = await ensureImplementationJobDispatched({
      store,
      issueKey,
      implementationSubjectIdentity: subjectIdentity,
      ownerGeneration: "gen-1",
      state,
    });
    expect(result.outcome).toBe("already_dispatched");
    expect(mocks.createImplementationJobAndDispatch).not.toHaveBeenCalled();
  });
});
