import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  LinearHarnessAgentProvider,
  resetLinearHarnessAgentProviderForTests,
} from "../../src/agents/linear-harness-provider.js";
import { createLinearHarnessLaunchContext } from "../../src/provenance/launch-context.js";
import { allocateProviderOperationId } from "../../src/provenance/provider-operation-id.js";
import { InMemoryProvenanceEventStore } from "../../src/provenance/store.js";
import { parseProvenanceKey } from "../../src/provenance/encryption.js";
import { CursorProvenanceError } from "../../src/provenance/errors.js";
import type { AgentHandle, AgentProvider } from "../../src/agents/types.js";
import type { EventLogger } from "../../src/artifacts/events.js";

const KEY = parseProvenanceKey("a".repeat(64));

function ctx() {
  return createLinearHarnessLaunchContext({
    operatorWorkspaceId: "ws",
    sourceProjectId: "proj",
    linearIssueId: "id-1",
    linearIssueKey: "WES-9",
    phase: "planning",
    phaseExecutionId: "run-9",
    harnessRunId: "run-9",
    providerOperationId: allocateProviderOperationId({
      issueKey: "WES-9",
      phase: "planning",
      harnessRunId: "run-9",
      agentRole: "planner",
      action: "create",
      generation: 1,
      launchSurface: "planning.create",
      operationOrdinal: 1,
    }),
    agentRole: "planner",
    action: "create",
    generation: 1,
    priorAgentHash: null,
    targetRepository: "https://github.com/o/r",
    startingRef: "main",
    prUrl: null,
    prNumber: null,
    orchestratorMarker: "harness-orchestrator-v1",
    orchestratorMarkerVersion: "v1",
    sourceRepositorySha: "s".repeat(40),
    runnerSnapshotVersion: "r1",
    workflowRunId: null,
    launchSurface: "planning.create",
  });
}

function fakeHandle(agentId: string): AgentHandle {
  return { __brand: Symbol("h") } as AgentHandle;
}

describe("LinearHarnessAgentProvider", () => {
  beforeEach(() => {
    resetLinearHarnessAgentProviderForTests();
  });

  it("writes intent and call-start before create, ack before returning handle", async () => {
    const store = new InMemoryProvenanceEventStore();
    const order: string[] = [];
    const handle = fakeHandle("bc-agent-1");
    const inner = {
      id: "cursor" as const,
      resolveModelId: () => "m",
      createPlanningAgent: vi.fn(async () => {
        order.push("create");
        return handle;
      }),
      createPlanReviewAgent: vi.fn(),
      createCodeReviewAgent: vi.fn(),
      createCodeRevisionAgent: vi.fn(),
      createImplementationAgent: vi.fn(),
      acquireBuilderAgent: vi.fn(),
      sendAndObserve: vi.fn(),
      disposeAgent: vi.fn(),
    } as unknown as AgentProvider;

    // peekCursorAgentId needs real cursor provider map — stub via wrapping create
    const { peekCursorAgentId } = await import(
      "../../src/agents/cursor-provider.js"
    );
    vi.spyOn(
      await import("../../src/agents/cursor-provider.js"),
      "peekCursorAgentId",
    ).mockReturnValue("bc-agent-1");

    const provider = new LinearHarnessAgentProvider({
      inner: inner as never,
      writerOptions: {
        mode: "required",
        store,
        encryptionKey: KEY,
      },
    });

    // Intercept write methods to record order
    const writer = provider.provenanceWriter;
    const intent = writer.writeLaunchIntent.bind(writer);
    const callStart = writer.writeProviderCallStarted.bind(writer);
    const ack = writer.writeAgentAcknowledged.bind(writer);
    writer.writeLaunchIntent = async (c) => {
      order.push("intent");
      return intent(c);
    };
    writer.writeProviderCallStarted = async (c) => {
      order.push("call_start");
      return callStart(c);
    };
    writer.writeAgentAcknowledged = async (c, id) => {
      order.push("ack");
      return ack(c, id);
    };

    await provider.createPlanningAgent({
      apiKey: "k",
      config: { orchestratorMarker: "harness-orchestrator-v1" } as never,
      targetRepo: "https://github.com/o/r",
      baseBranch: "main",
      launchContext: ctx(),
    });

    expect(order).toEqual(["intent", "call_start", "create", "ack"]);
    void peekCursorAgentId;
  });

  it("required mode blocks create when intent store missing", async () => {
    const create = vi.fn();
    const inner = {
      id: "cursor",
      resolveModelId: () => "m",
      createPlanningAgent: create,
      createPlanReviewAgent: vi.fn(),
      createCodeReviewAgent: vi.fn(),
      createCodeRevisionAgent: vi.fn(),
      createImplementationAgent: vi.fn(),
      acquireBuilderAgent: vi.fn(),
      sendAndObserve: vi.fn(),
      disposeAgent: vi.fn(),
    } as unknown as AgentProvider;

    const provider = new LinearHarnessAgentProvider({
      inner: inner as never,
      writerOptions: {
        mode: "required",
        store: null,
        encryptionKey: KEY,
      },
    });

    await expect(
      provider.createPlanningAgent({
        apiKey: "k",
        config: { orchestratorMarker: "x" } as never,
        targetRepo: "https://github.com/o/r",
        baseBranch: "main",
        launchContext: ctx(),
      }),
    ).rejects.toBeInstanceOf(CursorProvenanceError);
    expect(create).not.toHaveBeenCalled();
  });

  it("rejects send with mismatched launch context", async () => {
    const store = new InMemoryProvenanceEventStore();
    const handle = fakeHandle("bc-1");
    vi.spyOn(
      await import("../../src/agents/cursor-provider.js"),
      "peekCursorAgentId",
    ).mockReturnValue("bc-1");

    const inner = {
      id: "cursor",
      resolveModelId: () => "m",
      createPlanningAgent: vi.fn(async () => handle),
      createPlanReviewAgent: vi.fn(),
      createCodeReviewAgent: vi.fn(),
      createCodeRevisionAgent: vi.fn(),
      createImplementationAgent: vi.fn(),
      acquireBuilderAgent: vi.fn(),
      sendAndObserve: vi.fn(),
      disposeAgent: vi.fn(),
    } as unknown as AgentProvider;

    const provider = new LinearHarnessAgentProvider({
      inner: inner as never,
      writerOptions: { mode: "required", store, encryptionKey: KEY },
    });

    const launchContext = ctx();
    await provider.createPlanningAgent({
      apiKey: "k",
      config: { orchestratorMarker: "x" } as never,
      targetRepo: "https://github.com/o/r",
      baseBranch: "main",
      launchContext,
    });

    const other = createLinearHarnessLaunchContext({
      operatorWorkspaceId: launchContext.operatorWorkspaceId,
      sourceProjectId: launchContext.sourceProjectId,
      linearIssueId: launchContext.linearIssueId,
      linearIssueKey: launchContext.linearIssueKey,
      phase: launchContext.phase,
      phaseExecutionId: launchContext.phaseExecutionId,
      harnessRunId: launchContext.harnessRunId,
      providerOperationId: allocateProviderOperationId({
        issueKey: "WES-9",
        phase: "planning",
        harnessRunId: "run-9",
        agentRole: "planner",
        action: "create",
        generation: 1,
        launchSurface: "planning.create",
        operationOrdinal: 99,
      }),
      agentRole: launchContext.agentRole,
      action: launchContext.action,
      generation: launchContext.generation,
      priorAgentHash: launchContext.priorAgentHash,
      targetRepository: launchContext.targetRepository,
      startingRef: launchContext.startingRef,
      prUrl: launchContext.prUrl,
      prNumber: launchContext.prNumber,
      orchestratorMarker: launchContext.orchestratorMarker,
      orchestratorMarkerVersion: launchContext.orchestratorMarkerVersion,
      sourceRepositorySha: launchContext.sourceRepositorySha,
      runnerSnapshotVersion: launchContext.runnerSnapshotVersion,
      workflowRunId: launchContext.workflowRunId,
      launchSurface: launchContext.launchSurface,
    });

    const events = {
      log: vi.fn(),
    } as unknown as EventLogger;

    await expect(
      provider.sendAndObserve({
        agent: handle,
        prompt: "hi",
        runDirectory: "/tmp",
        events,
        launchContext: other,
      }),
    ).rejects.toMatchObject({
      code: "cursor_provenance_handle_attempt_mismatch",
    });
  });
});
