import { describe, expect, it, vi, beforeEach } from "vitest";
import { createHmac } from "node:crypto";
import { buildImplementationSubjectIdentity } from "../../src/workflow/subject-identities.js";
import { buildImplementationRequestId } from "../../src/workflow/implementation-dispatch-effect.js";

const mocks = vi.hoisted(() => ({
  loadHarnessConfig: vi.fn(),
  resolveImplementationSubject: vi.fn(),
  ensureImplementationJobDispatched: vi.fn(),
  createImplementationJobAndDispatch: vi.fn(),
  createEnvelopeAndDispatch: vi.fn(),
}));

vi.mock("../../src/config/load-config.js", () => ({
  loadHarnessConfig: mocks.loadHarnessConfig,
}));

vi.mock("../../src/workflow/resolve-implementation-subject.js", () => ({
  resolveImplementationSubject: mocks.resolveImplementationSubject,
}));

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

vi.mock("../../src/workflow/job-request/dispatch-opaque.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../src/workflow/job-request/dispatch-opaque.js")
    >();
  return {
    ...actual,
    createImplementationJobAndDispatch: mocks.createImplementationJobAndDispatch,
    createEnvelopeAndDispatch: mocks.createEnvelopeAndDispatch,
  };
});

import { handleLinearWebhook } from "../../src/webhook/handle-linear-webhook.js";

const secret = "test-webhook-secret";
const subjectIdentity = buildImplementationSubjectIdentity({
  issueKey: "FRE-6",
  targetRepo: "https://github.com/weston-uribe/weston-uribe-portfolio",
  baseBranch: "dev",
  planGenerationId: "120aa5ff-005a-44e7-aa5a-0b4922d951b4",
  planArtifactHash:
    "84076eff91fba2a0d2dd61d7da598f594d6362dd97186f1f3c7e4ef4dec56ba6",
  implementationCycle: 0,
});
const requestId = buildImplementationRequestId(subjectIdentity);

function sign(body: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

describe("Ready for Build webhook uses implementation subject", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.LINEAR_API_KEY = "lin";
    process.env.GITHUB_DISPATCH_TOKEN = "tok";
    mocks.loadHarnessConfig.mockResolvedValue({
      config: {
        version: 1,
        orchestratorMarker: "harness-orchestrator-v1",
        logDirectory: "/tmp",
        linear: {
          transitionalStatuses: { readyForBuild: "Ready for Build" },
        },
        repos: [
          {
            id: "portfolio",
            targetRepo: "https://github.com/weston-uribe/weston-uribe-portfolio",
            baseBranch: "dev",
            linearAssociations: [
              { workspaceId: "ws", teamId: "team-tt", projectId: "proj" },
            ],
          },
        ],
        allowedTargetRepos: [
          "https://github.com/weston-uribe/weston-uribe-portfolio",
        ],
      },
    });
    mocks.resolveImplementationSubject.mockResolvedValue({
      subjectIdentity,
      targetRepo: "https://github.com/weston-uribe/weston-uribe-portfolio",
      baseBranch: "dev",
      planGenerationId: "120aa5ff-005a-44e7-aa5a-0b4922d951b4",
      planArtifactHash:
        "84076eff91fba2a0d2dd61d7da598f594d6362dd97186f1f3c7e4ef4dec56ba6",
      implementationCycle: 0,
      state: { stateRevision: 1 },
      stateStore: { compareAndSet: vi.fn() },
      workflowStateRevision: 1,
    });
    mocks.ensureImplementationJobDispatched.mockResolvedValue({
      outcome: "dispatched",
      reviewRequestId: requestId,
      state: { stateRevision: 2 },
      httpDispatched: true,
    });
  });

  it("dispatches via impl-subject effect, not delivery-scoped envelope", async () => {
    const now = Date.now();
    const payload = {
      type: "Issue",
      action: "update",
      webhookTimestamp: now,
      data: {
        id: "iss",
        identifier: "FRE-6",
        url: "https://linear.app/x/issue/FRE-6",
        team: { id: "team-tt" },
        project: { id: "proj" },
        state: { id: "state-rfb", name: "Ready for Build" },
      },
      updatedFrom: { stateId: "state-old" },
    };
    const rawBody = JSON.stringify(payload);
    const result = await handleLinearWebhook({
      method: "POST",
      rawBody,
      webhookSecret: secret,
      dispatchToken: "tok",
      nowMs: now,
      headerGetter: (name) => {
        const n = name.toLowerCase();
        if (n === "linear-signature") return sign(rawBody);
        if (n === "linear-delivery") return "fb61e69d-9d2f-42aa-abe2-f3048c1a6a80";
        if (n === "linear-event") return "Issue";
        if (n === "linear-timestamp") return String(now);
        return null;
      },
    });

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      accepted: true,
      dispatched: true,
      requestId,
    });
    expect(mocks.ensureImplementationJobDispatched).toHaveBeenCalled();
    expect(mocks.createEnvelopeAndDispatch).not.toHaveBeenCalled();
  });
});
