import { beforeEach, describe, expect, it, vi } from "vitest";

const createMock = vi.hoisted(() => vi.fn());
const resumeMock = vi.hoisted(() => vi.fn());
const getMock = vi.hoisted(() => vi.fn());
const unarchiveMock = vi.hoisted(() => vi.fn());

vi.mock("@cursor/sdk", () => ({
  Agent: {
    create: createMock,
    resume: resumeMock,
    get: getMock,
    unarchive: unarchiveMock,
  },
}));

import {
  createImplementationCloudAgent,
  createIntegrationRepairCloudAgent,
  createPlanningCloudAgent,
  createReplacementBuilderCloudAgent,
  createRevisionCloudAgent,
  disposeCloudAgent,
  resumeBuilderCloudAgent,
} from "../../src/cursor/agent-factory.js";
import type { HarnessConfig } from "../../src/config/types.js";

const TARGET_REPO = "https://github.com/owner/example-target-app";

function makeConfig(overrides: Partial<HarnessConfig> = {}): HarnessConfig {
  return {
    version: 1,
    orchestratorMarker: "harness-orchestrator-v1",
    logDirectory: "runs",
    repos: [
      {
        id: "target-app",
        targetRepo: TARGET_REPO,
        baseBranch: "main",
        productionBranch: "main",
      },
    ],
    allowedTargetRepos: [TARGET_REPO],
    ...overrides,
  } as HarnessConfig;
}

/**
 * The model in an agent request must explicitly disable Fast and never enable
 * any premium / faster / max / high-reasoning variant.
 */
function assertStandardComposer(model: {
  id: string;
  params?: Array<{ id: string; value: string }>;
}): void {
  expect(model.id).toBe("composer-2.5");
  const params = model.params ?? [];
  expect(params).toContainEqual({ id: "fast", value: "false" });
  for (const param of params) {
    expect(param.value).not.toBe("true");
  }
}

/** The full request must never enable Fast/Max/high-reasoning. */
function assertRequestHasNoPremiumModes(request: unknown): void {
  const serialized = JSON.stringify(request).toLowerCase();
  expect(serialized).not.toContain('"value":"true"');
  expect(serialized).not.toContain("max");
  expect(serialized).not.toContain("high");
  expect(serialized).not.toContain("reasoning");
}

describe("disposeCloudAgent", () => {
  it("does not hang when agent disposal never resolves", async () => {
    vi.useFakeTimers();

    const agent = {
      [Symbol.asyncDispose]: vi.fn().mockImplementation(
        () => new Promise<void>(() => undefined),
      ),
    };

    const disposePromise = disposeCloudAgent(agent as never);
    await vi.advanceTimersByTimeAsync(10_000);
    await disposePromise;

    expect(agent[Symbol.asyncDispose]).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});

describe("cloud agent factories use basic Composer 2.5", () => {
  beforeEach(() => {
    createMock.mockReset();
    resumeMock.mockReset();
    getMock.mockReset();
    unarchiveMock.mockReset();
    createMock.mockResolvedValue({
      agentId: "agent-1",
      [Symbol.asyncDispose]: async () => undefined,
    });
    resumeMock.mockResolvedValue({
      agentId: "bc-resumed",
      [Symbol.asyncDispose]: async () => undefined,
    });
    getMock.mockResolvedValue({ agentId: "bc-resumed", archived: false });
    unarchiveMock.mockResolvedValue(undefined);
  });

  it("createPlanningCloudAgent requests standard Composer 2.5 and plan mode", async () => {
    await createPlanningCloudAgent({
      apiKey: "key",
      config: makeConfig(),
      targetRepo: TARGET_REPO,
      baseBranch: "dev",
    });

    expect(createMock).toHaveBeenCalledTimes(1);
    const request = createMock.mock.calls[0]![0];
    expect(request.model).toEqual({ id: "composer-2.5", params: [{ id: "fast", value: "false" }] });
    expect(request.mode).toBe("plan");
    expect(request.cloud.repos).toEqual([
      { url: TARGET_REPO, startingRef: "dev" },
    ]);
    expect(request.cloud.autoCreatePR).toBe(false);
    expect(request.cloud.skipReviewerRequest).toBe(true);
    assertStandardComposer(request.model);
  });

  it("createPlanningCloudAgent transmits explicit Fast when roleModels request it", async () => {
    await createPlanningCloudAgent({
      apiKey: "key",
      config: makeConfig({
        roleModels: {
          planner: {
            id: "composer-2.5",
            params: [{ id: "fast", value: "true" }],
          },
        },
      }),
      targetRepo: TARGET_REPO,
      baseBranch: "dev",
    });

    const request = createMock.mock.calls[0]![0];
    expect(request.model).toEqual({
      id: "composer-2.5",
      params: [{ id: "fast", value: "true" }],
    });
  });

  it("fails closed when provider rejects model parameters", async () => {
    createMock.mockRejectedValueOnce(new Error("Unsupported parameter fast"));
    await expect(
      createPlanningCloudAgent({
        apiKey: "key",
        config: makeConfig(),
        targetRepo: TARGET_REPO,
        baseBranch: "dev",
      }),
    ).rejects.toMatchObject({
      code: "model_parameter_rejected",
      modelId: "composer-2.5",
      failureClassification: "provider_model_parameter_rejected",
    });
  });

  it("createImplementationCloudAgent requests standard Composer 2.5 and agent mode", async () => {
    await createImplementationCloudAgent({
      apiKey: "key",
      config: makeConfig(),
      targetRepo: TARGET_REPO,
      baseBranch: "dev",
    });

    expect(createMock).toHaveBeenCalledTimes(1);
    const request = createMock.mock.calls[0]![0];
    expect(request.model).toEqual({ id: "composer-2.5", params: [{ id: "fast", value: "false" }] });
    expect(request.mode).toBe("agent");
    expect(request.cloud.repos).toEqual([
      { url: TARGET_REPO, startingRef: "dev" },
    ]);
    expect(request.cloud.autoCreatePR).toBe(true);
    expect(request.cloud.skipReviewerRequest).toBe(true);
    assertStandardComposer(request.model);
  });

  it("createRevisionCloudAgent requests standard Composer 2.5 with branch and PR", async () => {
    await createRevisionCloudAgent({
      apiKey: "key",
      config: makeConfig(),
      targetRepo: TARGET_REPO,
      branch: "cursor/wes-1",
      prUrl: "https://github.com/owner/example-target-app/pull/7",
    });

    expect(createMock).toHaveBeenCalledTimes(1);
    const request = createMock.mock.calls[0]![0];
    expect(request.model).toEqual({ id: "composer-2.5", params: [{ id: "fast", value: "false" }] });
    expect(request.mode).toBe("agent");
    expect(request.cloud.repos).toEqual([
      {
        url: TARGET_REPO,
        startingRef: "cursor/wes-1",
        prUrl:
          "https://github.com/owner/example-target-app/pull/7",
      },
    ]);
    expect(request.cloud.autoCreatePR).toBe(false);
    expect(request.cloud.skipReviewerRequest).toBe(true);
    assertStandardComposer(request.model);
  });

  it("createIntegrationRepairCloudAgent requests standard Composer 2.5 with branch and PR", async () => {
    await createIntegrationRepairCloudAgent({
      apiKey: "key",
      config: makeConfig(),
      targetRepo: TARGET_REPO,
      branch: "cursor/wes-1",
      prUrl: "https://github.com/owner/example-target-app/pull/7",
    });

    expect(createMock).toHaveBeenCalledTimes(1);
    const request = createMock.mock.calls[0]![0];
    expect(request.model).toEqual({ id: "composer-2.5", params: [{ id: "fast", value: "false" }] });
    expect(request.mode).toBe("agent");
    expect(request.cloud.repos).toEqual([
      {
        url: TARGET_REPO,
        startingRef: "cursor/wes-1",
        prUrl:
          "https://github.com/owner/example-target-app/pull/7",
      },
    ]);
    expect(request.cloud.autoCreatePR).toBe(false);
    expect(request.cloud.skipReviewerRequest).toBe(true);
    assertStandardComposer(request.model);
  });

  it("uses explicit roleModels for planner and builder agent creation", async () => {
    const roleConfig = makeConfig({
      roleModels: {
        planner: { id: "planner-role-model", params: [{ id: "fast", value: "false" }] },
        builder: { id: "builder-role-model", params: [{ id: "fast", value: "false" }] },
      },
    });

    await createPlanningCloudAgent({
      apiKey: "key",
      config: roleConfig,
      targetRepo: TARGET_REPO,
      baseBranch: "dev",
    });
    expect(createMock.mock.calls[0]![0].model.id).toBe("planner-role-model");

    createMock.mockClear();

    await createImplementationCloudAgent({
      apiKey: "key",
      config: roleConfig,
      targetRepo: TARGET_REPO,
      baseBranch: "dev",
    });
    expect(createMock.mock.calls[0]![0].model.id).toBe("builder-role-model");

    createMock.mockClear();

    await createRevisionCloudAgent({
      apiKey: "key",
      config: roleConfig,
      targetRepo: TARGET_REPO,
      branch: "cursor/wes-1",
      prUrl: "https://github.com/owner/example-target-app/pull/7",
    });
    expect(createMock.mock.calls[0]![0].model.id).toBe("builder-role-model");

    createMock.mockClear();

    await createIntegrationRepairCloudAgent({
      apiKey: "key",
      config: roleConfig,
      targetRepo: TARGET_REPO,
      branch: "cursor/wes-1",
      prUrl: "https://github.com/owner/example-target-app/pull/7",
    });
    expect(createMock.mock.calls[0]![0].model.id).toBe("builder-role-model");
  });

  it("never sends Fast/Max/high-reasoning in any factory request", async () => {
    await createPlanningCloudAgent({
      apiKey: "key",
      config: makeConfig(),
      targetRepo: TARGET_REPO,
      baseBranch: "main",
    });
    await createImplementationCloudAgent({
      apiKey: "key",
      config: makeConfig(),
      targetRepo: TARGET_REPO,
      baseBranch: "main",
    });
    await createRevisionCloudAgent({
      apiKey: "key",
      config: makeConfig(),
      targetRepo: TARGET_REPO,
      branch: "cursor/wes-1",
      prUrl: "https://github.com/owner/example-target-app/pull/7",
    });
    await createIntegrationRepairCloudAgent({
      apiKey: "key",
      config: makeConfig(),
      targetRepo: TARGET_REPO,
      branch: "cursor/wes-1",
      prUrl: "https://github.com/owner/example-target-app/pull/7",
    });

    for (const call of createMock.mock.calls) {
      assertRequestHasNoPremiumModes(call[0]);
    }
  });

  it("creates replacement builders on the existing PR branch without autoCreatePR", async () => {
    await createReplacementBuilderCloudAgent({
      apiKey: "key",
      config: makeConfig(),
      targetRepo: TARGET_REPO,
      branch: "cursor/wes-1",
      prUrl: "https://github.com/owner/example-target-app/pull/7",
    });
    expect(createMock.mock.calls[0]![0]).toMatchObject({
      cloud: {
        repos: [
          {
            url: TARGET_REPO,
            startingRef: "cursor/wes-1",
            prUrl: "https://github.com/owner/example-target-app/pull/7",
          },
        ],
        autoCreatePR: false,
        skipReviewerRequest: true,
      },
    });
  });

  it("resumes Builder agents via get, optional unarchive, and resume", async () => {
    const events = { log: vi.fn() };
    getMock.mockResolvedValue({ agentId: "bc-resumed", archived: false });

    const agent = await resumeBuilderCloudAgent({
      apiKey: "key",
      agentId: "bc-resumed",
      events: events as never,
    });

    expect(getMock).toHaveBeenCalledWith("bc-resumed", { apiKey: "key" });
    expect(unarchiveMock).not.toHaveBeenCalled();
    expect(resumeMock).toHaveBeenCalledWith("bc-resumed", { apiKey: "key" });
    expect(agent.agentId).toBe("bc-resumed");
  });

  it("unarchives archived Builder agents before resume", async () => {
    const events = { log: vi.fn() };
    getMock.mockResolvedValue({ agentId: "bc-archived", archived: true });

    await resumeBuilderCloudAgent({
      apiKey: "key",
      agentId: "bc-archived",
      events: events as never,
    });

    expect(unarchiveMock).toHaveBeenCalledWith("bc-archived", { apiKey: "key" });
    expect(events.log).toHaveBeenCalledWith(
      "builder_thread_unarchived",
      "info",
      { agentId: "bc-archived" },
    );
    expect(resumeMock).toHaveBeenCalledWith("bc-archived", { apiKey: "key" });
  });
});
