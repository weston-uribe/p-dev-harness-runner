import { cursorAgentProvider } from "./cursor-provider.js";
import { getAgentProvider } from "./provider.js";
import type {
  AcquireBuilderAgentParams,
  AcquiredBuilderAgent,
  AgentHandle,
  CodeReviewAgentParams,
  CodeRevisionAgentParams,
  ImplementationAgentParams,
  PlanningAgentParams,
  SendAndObserveOptions,
} from "./types.js";
import type { HarnessConfig } from "../config/types.js";
import type { EventLogger } from "../artifacts/events.js";

export function resolveModelId(config: HarnessConfig): string {
  return getAgentProvider(config).resolveModelId(config);
}

export function createPlanningAgent(
  params: PlanningAgentParams,
): Promise<AgentHandle> {
  return getAgentProvider(params.config).createPlanningAgent(params);
}

export function createPlanReviewAgent(
  params: PlanningAgentParams,
): Promise<AgentHandle> {
  return getAgentProvider(params.config).createPlanReviewAgent(params);
}

export async function resumePlanReviewAgent(input: {
  apiKey: string;
  agentId: string;
  config: HarnessConfig;
}): Promise<AgentHandle> {
  const provider = getAgentProvider(input.config);
  if (!provider.resumePlanReviewAgent) {
    throw new Error("Agent provider does not support Plan Review resume");
  }
  return provider.resumePlanReviewAgent({
    apiKey: input.apiKey,
    agentId: input.agentId,
  });
}

export function createCodeReviewAgent(
  params: CodeReviewAgentParams,
): Promise<AgentHandle> {
  return getAgentProvider(params.config).createCodeReviewAgent(params);
}

export function createCodeRevisionAgent(
  params: CodeRevisionAgentParams,
): Promise<AgentHandle> {
  return getAgentProvider(params.config).createCodeRevisionAgent(params);
}

export function createImplementationAgent(
  params: ImplementationAgentParams,
): Promise<AgentHandle> {
  return getAgentProvider(params.config).createImplementationAgent(params);
}

export function acquireBuilderAgent(
  params: AcquireBuilderAgentParams,
): Promise<AcquiredBuilderAgent> {
  return getAgentProvider(params.config).acquireBuilderAgent(params);
}

export function sendAndObserve(
  agent: AgentHandle,
  prompt: string,
  runDirectory: string,
  events: EventLogger,
  options?: SendAndObserveOptions,
): Promise<import("./types.js").ObservedAgentRun> {
  return cursorAgentProvider.sendAndObserve(
    agent,
    prompt,
    runDirectory,
    events,
    options,
  );
}

export function disposeAgent(agent: AgentHandle): Promise<void> {
  return cursorAgentProvider.disposeAgent(agent);
}

export async function downloadAgentReviewArtifacts(
  agent: AgentHandle,
): Promise<import("../cursor/review-artifacts.js").DownloadedReviewArtifact[]> {
  const { downloadAgentReviewArtifacts: download } = await import(
    "./cursor-provider.js"
  );
  return download(agent);
}

export type {
  AcquireBuilderAgentParams,
  AcquiredBuilderAgent,
  AgentHandle,
  CapturedGitResult,
  CursorCancelOutcome,
  ObservedAgentRun,
  SendAndObserveOptions,
} from "./types.js";
