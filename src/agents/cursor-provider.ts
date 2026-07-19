import {
  createCodeReviewCloudAgent,
  createCodeRevisionCloudAgent,
  createImplementationCloudAgent,
  createPlanReviewCloudAgent,
  createPlanningCloudAgent,
  disposeCloudAgent,
} from "../cursor/agent-factory.js";
import { resolveModelId as cursorResolveModelId } from "../cursor/model.js";
import { sendAndObserve as cursorSendAndObserve } from "../cursor/run-observer.js";
import { acquireBuilderAgent as acquireBuilderAgentImpl } from "../runner/builder-thread-acquire.js";
import { unavailableCost, buildUsageRecord } from "../evaluation/telemetry/cost.js";
import type {
  AcquiredBuilderAgent,
  AcquireBuilderAgentParams,
  AgentHandle,
  AgentProvider,
  CodeReviewAgentParams,
  CodeRevisionAgentParams,
  ImplementationAgentParams,
  ObservedAgentRun,
  PlanningAgentParams,
  SendAndObserveOptions,
} from "./types.js";
import type { HarnessConfig } from "../config/types.js";
import type { EventLogger } from "../artifacts/events.js";

type CursorCloudAgent = Awaited<ReturnType<typeof createPlanningCloudAgent>>;

const cursorAgents = new WeakMap<AgentHandle, CursorCloudAgent>();

function wrapCursorAgent(agent: CursorCloudAgent): AgentHandle {
  const handle = { __brand: Symbol("AgentHandle") } as AgentHandle;
  cursorAgents.set(handle, agent);
  return handle;
}

function unwrapCursorAgent(handle: AgentHandle): CursorCloudAgent {
  const agent = cursorAgents.get(handle);
  if (!agent) {
    throw new Error("Invalid or disposed agent handle");
  }
  return agent;
}

function mapObservedRun(
  observed: Awaited<ReturnType<typeof cursorSendAndObserve>>,
): ObservedAgentRun {
  const model = observed.result?.model;
  const modelParams =
    model && typeof model.id === "string" && Array.isArray(model.params)
      ? model.params.map((p) => ({
          id: String(p.id),
          value: String(p.value),
        }))
      : undefined;
  const modelId =
    model && typeof model.id === "string" ? model.id : undefined;
  const usageRaw = observed.result?.usage;
  // Cost must use resolved model + params (Fast vs Standard), not base ID alone.
  const usage = buildUsageRecord(usageRaw, modelId, modelParams);
  return {
    agentId: observed.agentId,
    runId: observed.runId,
    requestId: observed.requestId,
    assistantText: observed.assistantText,
    gitResult: observed.gitResult,
    cancelOutcome: observed.cancelOutcome,
    status: observed.result?.status,
    durationMs: observed.result?.durationMs ?? null,
    model:
      model && typeof model.id === "string"
        ? {
            id: model.id,
            params: modelParams,
          }
        : null,
    usage: usage ?? { cost: unavailableCost() },
    artifactRefs: observed.artifactRefs,
    eventCounts: observed.eventCounts,
    completeness: observed.completeness,
  };
}

export const cursorAgentProvider: AgentProvider = {
  id: "cursor",

  resolveModelId(config: HarnessConfig): string {
    return cursorResolveModelId(config);
  },

  async createPlanningAgent(params: PlanningAgentParams): Promise<AgentHandle> {
    const agent = await createPlanningCloudAgent(params);
    return wrapCursorAgent(agent);
  },

  async createPlanReviewAgent(params: PlanningAgentParams): Promise<AgentHandle> {
    const agent = await createPlanReviewCloudAgent(params);
    return wrapCursorAgent(agent);
  },

  async createCodeReviewAgent(
    params: CodeReviewAgentParams,
  ): Promise<AgentHandle> {
    const agent = await createCodeReviewCloudAgent(params);
    return wrapCursorAgent(agent);
  },

  async createCodeRevisionAgent(
    params: CodeRevisionAgentParams,
  ): Promise<AgentHandle> {
    const agent = await createCodeRevisionCloudAgent(params);
    return wrapCursorAgent(agent);
  },

  async createImplementationAgent(
    params: ImplementationAgentParams,
  ): Promise<AgentHandle> {
    const agent = await createImplementationCloudAgent(params);
    return wrapCursorAgent(agent);
  },

  async acquireBuilderAgent(
    params: AcquireBuilderAgentParams,
  ): Promise<AcquiredBuilderAgent> {
    const acquired = await acquireBuilderAgentImpl(params);
    return {
      agent: wrapCursorAgent(acquired.agent),
      continuity: acquired.continuity,
    };
  },

  async sendAndObserve(
    agent: AgentHandle,
    prompt: string,
    runDirectory: string,
    events: EventLogger,
    options: SendAndObserveOptions = {},
  ): Promise<ObservedAgentRun> {
    const observed = await cursorSendAndObserve(
      unwrapCursorAgent(agent),
      prompt,
      runDirectory,
      events,
      options,
    );
    return mapObservedRun(observed);
  },

  async disposeAgent(agent: AgentHandle): Promise<void> {
    const cursorAgent = cursorAgents.get(agent);
    if (!cursorAgent) {
      return;
    }
    cursorAgents.delete(agent);
    await disposeCloudAgent(cursorAgent);
  },
};
