import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  LinearHarnessAgentProvider,
  resetLinearHarnessAgentProviderForTests,
} from "../../src/agents/linear-harness-provider.js";
import { createLinearHarnessLaunchContext } from "../../src/provenance/launch-context.js";
import { allocateProviderOperationId } from "../../src/provenance/provider-operation-id.js";
import { allocateProviderRunOperationId } from "../../src/provenance/run-operation-id.js";
import { InMemoryProvenanceEventStore } from "../../src/provenance/store.js";
import { parseProvenanceKey } from "../../src/provenance/encryption.js";
import { computeLaunchAttemptId } from "../../src/provenance/launch-attempt-id.js";
import type { AgentHandle, AgentProvider, ObservedAgentRun } from "../../src/agents/types.js";
import type { EventLogger } from "../../src/artifacts/events.js";
import { buildCoverageSnapshotFromLegacy, projectAttempts } from "../../src/provenance/coverage.js";
import { provenanceEventRemotePath } from "../../src/provenance/paths.js";

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

function fakeHandle(): AgentHandle {
  return { __brand: Symbol("h") } as AgentHandle;
}

describe("pre-send run operation provenance", () => {
  beforeEach(() => {
    resetLinearHarnessAgentProviderForTests();
  });

  it("writes run intent and call-start before agent.send; distinct repair ordinals", async () => {
    const store = new InMemoryProvenanceEventStore();
    const handle = fakeHandle();
    const order: string[] = [];
    let sendSeq = 0;
    vi.spyOn(
      await import("../../src/agents/cursor-provider.js"),
      "peekCursorAgentId",
    ).mockReturnValue("bc-agent-1");

    const inner = {
      id: "cursor",
      resolveModelId: () => "m",
      createPlanningAgent: vi.fn(async () => handle),
      createPlanReviewAgent: vi.fn(),
      createCodeReviewAgent: vi.fn(),
      createCodeRevisionAgent: vi.fn(),
      createImplementationAgent: vi.fn(),
      acquireBuilderAgent: vi.fn(),
      sendAndObserve: vi.fn(async (_a, _p, _d, _e, options) => {
        order.push("send");
        sendSeq += 1;
        const runId = `run-${sendSeq}`;
        await options?.onRunAcknowledged?.({
          agentId: "bc-agent-1",
          runId,
          acknowledgedAt: "2026-07-22T00:01:00.000Z",
          providerRunCreatedAt: null,
        });
        await options?.onRunTerminal?.({
          agentId: "bc-agent-1",
          runId,
          terminalStatus: "FINISHED",
          terminalAt: "2026-07-22T00:02:00.000Z",
          providerTerminalAt: null,
        });
        return {
          agentId: "bc-agent-1",
          runId,
          assistantText: "ok",
          gitResult: null,
          cancelOutcome: null,
        } satisfies ObservedAgentRun;
      }),
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

    const events = { log: vi.fn() } as unknown as EventLogger;
    const writer = provider.provenanceWriter;
    const intentFn = writer.writeProviderRunIntent.bind(writer);
    const callFn = writer.writeProviderRunCallStarted.bind(writer);
    writer.writeProviderRunIntent = async (c, i) => {
      order.push("run_intent");
      return intentFn(c, i);
    };
    writer.writeProviderRunCallStarted = async (c, i) => {
      order.push("run_call_start");
      return callFn(c, i);
    };

    await provider.sendAndObserve({
      agent: handle,
      prompt: "plan",
      runDirectory: "/tmp",
      events,
      launchContext,
      sendSurface: "planning.send",
      sendOrdinal: 1,
    });
    expect(order).toEqual(["run_intent", "run_call_start", "send"]);

    order.length = 0;
    await provider.sendAndObserve({
      agent: handle,
      prompt: "repair",
      runDirectory: "/tmp",
      events,
      launchContext,
      sendSurface: "planning.send.quality_repair",
      sendOrdinal: 2,
    });

    const launchAttemptId = computeLaunchAttemptId(launchContext);
    const op1 = allocateProviderRunOperationId({
      launchAttemptId,
      sendSurface: "planning.send",
      sendOrdinal: 1,
    });
    const op2 = allocateProviderRunOperationId({
      launchAttemptId,
      sendSurface: "planning.send.quality_repair",
      sendOrdinal: 2,
    });
    expect(op1).not.toBe(op2);

    const runOps = store
      .listEvents()
      .filter((e) => e.eventType === "provider_run_intent")
      .map((e) =>
        e.eventType === "provider_run_intent" ? e.providerRunOperationId : "",
      );
    expect(runOps).toEqual([op1, op2]);

    // Logical retry of the same send reuses the same run-operation id (idempotent intent).
    const retryIntent = await provider.provenanceWriter.writeProviderRunIntent(
      launchContext,
      {
        providerRunOperationId: op2,
        sendSurface: "planning.send.quality_repair",
        sendOrdinal: 2,
      },
    );
    expect(retryIntent.ok).toBe(true);
    expect(retryIntent.idempotent).toBe(true);
    const intents = store
      .listEvents()
      .filter((e) => e.eventType === "provider_run_intent");
    expect(intents).toHaveLength(2);
  });

  it("required run-intent failure never calls agent.send", async () => {
    const store = new InMemoryProvenanceEventStore();
    const handle = fakeHandle();
    vi.spyOn(
      await import("../../src/agents/cursor-provider.js"),
      "peekCursorAgentId",
    ).mockReturnValue("bc-agent-1");
    const send = vi.fn();
    const provider = new LinearHarnessAgentProvider({
      inner: {
        id: "cursor",
        resolveModelId: () => "m",
        createPlanningAgent: vi.fn(async () => handle),
        createPlanReviewAgent: vi.fn(),
        createCodeReviewAgent: vi.fn(),
        createCodeRevisionAgent: vi.fn(),
        createImplementationAgent: vi.fn(),
        acquireBuilderAgent: vi.fn(),
        sendAndObserve: send,
        disposeAgent: vi.fn(),
      } as never,
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
    provider.provenanceWriter.writeProviderRunIntent = async () => ({
      ok: false,
      blocked: true,
      error: new (await import("../../src/provenance/errors.js")).CursorProvenanceError(
        "cursor_provenance_run_intent_write_failed",
        "fail",
      ),
    });
    await expect(
      provider.sendAndObserve({
        agent: handle,
        prompt: "x",
        runDirectory: "/tmp",
        events: { log: vi.fn() } as unknown as EventLogger,
        launchContext,
      }),
    ).rejects.toBeTruthy();
    expect(send).not.toHaveBeenCalled();
  });

  it("crash after run call-start leaves coverage incomplete", async () => {
    const store = new InMemoryProvenanceEventStore();
    const handle = fakeHandle();
    vi.spyOn(
      await import("../../src/agents/cursor-provider.js"),
      "peekCursorAgentId",
    ).mockReturnValue("bc-agent-1");
    const provider = new LinearHarnessAgentProvider({
      inner: {
        id: "cursor",
        resolveModelId: () => "m",
        createPlanningAgent: vi.fn(async () => handle),
        createPlanReviewAgent: vi.fn(),
        createCodeReviewAgent: vi.fn(),
        createCodeRevisionAgent: vi.fn(),
        createImplementationAgent: vi.fn(),
        acquireBuilderAgent: vi.fn(),
        sendAndObserve: vi.fn(async () => {
          throw new Error("crash after send began");
        }),
        disposeAgent: vi.fn(),
      } as never,
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
    await expect(
      provider.sendAndObserve({
        agent: handle,
        prompt: "x",
        runDirectory: "/tmp",
        events: { log: vi.fn() } as unknown as EventLogger,
        launchContext,
        sendSurface: "planning.send",
        sendOrdinal: 1,
      }),
    ).rejects.toThrow(/crash/);

    const events = store.listEvents();
    const attempts = projectAttempts(events);
    expect(attempts.some((a) => a.unresolved)).toBe(true);
    const paths = events.map((e) =>
      provenanceEventRemotePath({
        launchAttemptId: e.launchAttemptId,
        eventType: e.eventType,
        bindingOrStageId:
          e.eventType === "provider_run_intent" ||
          e.eventType === "provider_run_call_started"
            ? e.providerRunOperationId
            : e.eventType === "provider_run_bound" ||
                e.eventType === "execution_completed"
              ? e.runHash
              : e.eventType === "launch_failed"
                ? `${e.failureStage}:${e.failureCategory}`
                : undefined,
      }),
    );
    const snap = buildCoverageSnapshotFromLegacy({
      interval: {
        coverageStart: "2026-07-01T00:00:00.000Z",
        coverageEnd: "2026-08-01T00:00:00.000Z",
      },
      events,
      eventPaths: paths,
      immutableEventSetCommitSha: "c".repeat(40),
    });
    expect(snap.status).toBe("incomplete");
    expect(snap.runCallWithoutAcknowledgmentCount).toBeGreaterThan(0);
  });
});
