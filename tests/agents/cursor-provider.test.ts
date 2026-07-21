import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cursorAgentProvider } from "../../src/agents/cursor-provider.js";
import { getAgentProvider } from "../../src/agents/provider.js";
import type { HarnessConfig } from "../../src/config/types.js";

const factoryMocks = vi.hoisted(() => ({
  createPlanningCloudAgent: vi.fn(),
  createImplementationCloudAgent: vi.fn(),
  disposeCloudAgent: vi.fn(),
}));

const acquireMocks = vi.hoisted(() => ({
  acquireBuilderAgent: vi.fn(),
}));

const observerMocks = vi.hoisted(() => ({
  sendAndObserve: vi.fn(),
}));

const modelMocks = vi.hoisted(() => ({
  resolveModelId: vi.fn(),
}));

vi.mock("../../src/cursor/agent-factory.js", () => ({
  createPlanningCloudAgent: factoryMocks.createPlanningCloudAgent,
  createImplementationCloudAgent: factoryMocks.createImplementationCloudAgent,
  disposeCloudAgent: factoryMocks.disposeCloudAgent,
}));

vi.mock("../../src/runner/builder-thread-acquire.js", () => ({
  acquireBuilderAgent: acquireMocks.acquireBuilderAgent,
}));

vi.mock("../../src/cursor/run-observer.js", () => ({
  sendAndObserve: observerMocks.sendAndObserve,
}));

vi.mock("../../src/cursor/model.js", () => ({
  resolveModelId: modelMocks.resolveModelId,
}));

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

function mockCursorAgent(id = "agent-1") {
  return {
    agentId: id,
    [Symbol.asyncDispose]: async () => undefined,
  };
}

describe("getAgentProvider", () => {
  it("returns a Cursor provider", () => {
    const provider = getAgentProvider(makeConfig());
    expect(provider.id).toBe("cursor");
  });
});

describe("cursorAgentProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    factoryMocks.disposeCloudAgent.mockResolvedValue(undefined);
  });

  it("delegates resolveModelId to cursor model resolution", () => {
    const config = makeConfig({
      agentProvider: { id: "cursor", model: { id: "composer-2.5" } },
      defaultModel: { id: "other-model" },
    });
    modelMocks.resolveModelId.mockReturnValue("composer-2.5");

    expect(cursorAgentProvider.resolveModelId(config)).toBe("composer-2.5");
    expect(modelMocks.resolveModelId).toHaveBeenCalledWith(config);
  });

  it("delegates createPlanningAgent to createPlanningCloudAgent", async () => {
    const cursorAgent = mockCursorAgent();
    factoryMocks.createPlanningCloudAgent.mockResolvedValue(cursorAgent);
    const config = makeConfig();
    const params = {
      apiKey: "key",
      config,
      targetRepo: TARGET_REPO,
      baseBranch: "dev",
    };

    const handle = await cursorAgentProvider.createPlanningAgent(params);

    expect(factoryMocks.createPlanningCloudAgent).toHaveBeenCalledWith(params);
    expect(handle).toBeDefined();
    expect((handle as { __brand?: symbol }).__brand).toBeDefined();
  });

  it("delegates createImplementationAgent to createImplementationCloudAgent", async () => {
    factoryMocks.createImplementationCloudAgent.mockResolvedValue(mockCursorAgent());
    const config = makeConfig();
    const params = {
      apiKey: "key",
      config,
      targetRepo: TARGET_REPO,
      baseBranch: "dev",
    };

    await cursorAgentProvider.createImplementationAgent(params);

    expect(factoryMocks.createImplementationCloudAgent).toHaveBeenCalledWith(params);
  });

  it("delegates acquireBuilderAgent to builder-thread acquire", async () => {
    const cursorAgent = mockCursorAgent("builder-1");
    acquireMocks.acquireBuilderAgent.mockResolvedValue({
      agent: cursorAgent,
      continuity: {
        action: "resumed",
        reference: {
          agentId: "builder-1",
          generation: 1,
          originHarnessRunId: "run-1",
          latestHarnessRunId: "run-2",
          sourcePhase: "revision",
          targetRepo: TARGET_REPO,
        },
      },
    });
    const config = makeConfig();
    const params = {
      apiKey: "key",
      config,
      phase: "revision" as const,
      context: {
        issueKey: "WES-1",
        harnessRunId: "run-2",
        targetRepo: TARGET_REPO,
        baseBranch: "main",
        branch: "cursor/wes-1-test",
        prUrl: `${TARGET_REPO}/pull/1`,
        idempotencyKey: "p-dev:revision:WES-1:comment-1",
        comments: [],
        orchestratorMarker: config.orchestratorMarker,
      },
      events: { log: vi.fn() } as never,
    };

    const acquired = await cursorAgentProvider.acquireBuilderAgent(params);

    expect(acquireMocks.acquireBuilderAgent).toHaveBeenCalledWith(params);
    expect(acquired.continuity.action).toBe("resumed");
    expect((acquired.agent as { __brand?: symbol }).__brand).toBeDefined();
  });

  it("maps ObservedRunResult to ObservedAgentRun without dropping fields", async () => {
    const cursorAgent = mockCursorAgent();
    factoryMocks.createPlanningCloudAgent.mockResolvedValue(cursorAgent);
    observerMocks.sendAndObserve.mockResolvedValue({
      agentId: "agent-1",
      runId: "run-1",
      result: { id: "run-1", status: "completed" },
      assistantText: "plan output",
      gitResult: {
        repoUrl: TARGET_REPO,
        branch: "cursor/wes-1-test",
        prUrl: `${TARGET_REPO}/pull/1`,
      },
      cancelOutcome: "cancelled",
    });

    const handle = await cursorAgentProvider.createPlanningAgent({
      apiKey: "key",
      config: makeConfig(),
      targetRepo: TARGET_REPO,
      baseBranch: "dev",
    });

    const observed = await cursorAgentProvider.sendAndObserve(
      handle,
      "prompt",
      "/tmp/run",
      { log: vi.fn() } as never,
      { phase: "planning", apiKey: "key" },
    );

    expect(observerMocks.sendAndObserve).toHaveBeenCalledWith(
      cursorAgent,
      "prompt",
      "/tmp/run",
      expect.anything(),
      { phase: "planning", apiKey: "key" },
    );
    expect(observed).toMatchObject({
      agentId: "agent-1",
      runId: "run-1",
      assistantText: "plan output",
      gitResult: {
        repoUrl: TARGET_REPO,
        branch: "cursor/wes-1-test",
        prUrl: `${TARGET_REPO}/pull/1`,
      },
      cancelOutcome: "cancelled",
      status: "completed",
      durationMs: null,
      model: null,
      usage: { cost: { costSource: "unavailable" } },
    });
  });

  it("preserves model and full usage including cache tokens", async () => {
    const cursorAgent = mockCursorAgent();
    factoryMocks.createPlanningCloudAgent.mockResolvedValue(cursorAgent);
    observerMocks.sendAndObserve.mockResolvedValue({
      agentId: "agent-1",
      runId: "run-1",
      requestId: "req-1",
      result: {
        id: "run-1",
        status: "finished",
        durationMs: 100,
        model: { id: "composer-2.5" },
        usage: {
          inputTokens: 10,
          outputTokens: 20,
          totalTokens: 30,
          cacheReadTokens: 4,
          cacheWriteTokens: 2,
          reasoningTokens: 1,
        },
      },
      assistantText: "ok",
      gitResult: null,
      cancelOutcome: null,
      eventCounts: { total: 2, byKind: {}, toolStarted: 0, toolFinished: 0, toolError: 0, toolIncomplete: 0 },
      completeness: {
        trace_input_present: false,
        trace_output_present: false,
        agent_input_present: true,
        agent_output_present: true,
        model_present: true,
        usage_present: true,
        tool_events_present: false,
        tool_event_completion_rate: null,
        prompt_provenance_present: true,
        skill_provenance_present: true,
        pm_feedback_present: null,
      },
    });

    const handle = await cursorAgentProvider.createPlanningAgent({
      apiKey: "key",
      config: makeConfig(),
      targetRepo: TARGET_REPO,
      baseBranch: "dev",
    });
    const observed = await cursorAgentProvider.sendAndObserve(
      handle,
      "prompt",
      "/tmp/run",
      { log: vi.fn() } as never,
    );

    expect(observed.model?.id).toBe("composer-2.5");
    expect(observed.requestId).toBe("req-1");
    expect(observed.usage).toMatchObject({
      inputTokens: 10,
      outputTokens: 20,
      totalTokens: 30,
      cacheReadTokens: 4,
      cacheWriteTokens: 2,
      reasoningTokens: 1,
      cost: { costSource: "pricing_registry" },
    });
    expect(observed.completeness?.model_present).toBe(true);
  });

  it("delegates disposeAgent to disposeCloudAgent", async () => {
    const cursorAgent = mockCursorAgent();
    factoryMocks.createPlanningCloudAgent.mockResolvedValue(cursorAgent);
    const handle = await cursorAgentProvider.createPlanningAgent({
      apiKey: "key",
      config: makeConfig(),
      targetRepo: TARGET_REPO,
      baseBranch: "dev",
    });

    await cursorAgentProvider.disposeAgent(handle);

    expect(factoryMocks.disposeCloudAgent).toHaveBeenCalledWith(cursorAgent);
  });
});

describe("src/agents sdk import boundary", () => {
  it("contains no direct @cursor/sdk imports", async () => {
    const agentsDir = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../src/agents",
    );
    const files = ["types.ts", "provider.ts", "cursor-provider.ts", "index.ts"];
    for (const file of files) {
      const contents = await readFile(path.join(agentsDir, file), "utf8");
      expect(contents).not.toContain("@cursor/sdk");
    }
  });
});
