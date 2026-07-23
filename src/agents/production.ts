/**
 * Production Linear-harness agent entrypoints.
 * Phase modules must import create/resume/acquire/send from here —
 * not from generic agents/index or agent-factory.
 */

import {
  getLinearHarnessAgentProvider,
  type LinearHarnessAcquireBuilderParams,
  type LinearHarnessBranchParams,
  type LinearHarnessCreateParams,
  type LinearHarnessResumePlanReviewParams,
} from "./linear-harness-provider.js";
import type {
  AcquiredBuilderAgent,
  AgentHandle,
  ObservedAgentRun,
  SendAndObserveOptions,
} from "./types.js";
import type { EventLogger } from "../artifacts/events.js";
import type { LinearHarnessLaunchContext } from "../provenance/launch-context.js";

export {
  buildLinearHarnessLaunchContext,
  priorAgentHashFromId,
  getLinearHarnessAgentProvider,
  resetLinearHarnessAgentProviderForTests,
} from "./linear-harness-provider.js";

export type ProductionSendAndObserveOptions = SendAndObserveOptions & {
  launchContext: LinearHarnessLaunchContext;
  /** Durable per-send identity operands (restart-stable). */
  providerRunOperationId?: string;
  sendPurpose?: string;
  sendOrdinal?: number;
};

export async function createPlanningAgent(
  params: LinearHarnessCreateParams,
): Promise<AgentHandle> {
  return getLinearHarnessAgentProvider().createPlanningAgent(params);
}

export async function createPlanReviewAgent(
  params: LinearHarnessCreateParams,
): Promise<AgentHandle> {
  return getLinearHarnessAgentProvider().createPlanReviewAgent(params);
}

export async function resumePlanReviewAgent(
  params: LinearHarnessResumePlanReviewParams,
): Promise<AgentHandle> {
  return getLinearHarnessAgentProvider().resumePlanReviewAgent(params);
}

export async function createCodeReviewAgent(
  params: LinearHarnessBranchParams,
): Promise<AgentHandle> {
  return getLinearHarnessAgentProvider().createCodeReviewAgent(params);
}

export async function createCodeRevisionAgent(
  params: LinearHarnessBranchParams,
): Promise<AgentHandle> {
  return getLinearHarnessAgentProvider().createCodeRevisionAgent(params);
}

export async function acquireBuilderAgent(
  params: LinearHarnessAcquireBuilderParams,
): Promise<AcquiredBuilderAgent> {
  return getLinearHarnessAgentProvider().acquireBuilderAgent(params);
}

export async function sendAndObserve(
  agent: AgentHandle,
  prompt: string,
  runDirectory: string,
  events: EventLogger,
  options: ProductionSendAndObserveOptions,
): Promise<ObservedAgentRun> {
  const {
    launchContext,
    providerRunOperationId,
    sendPurpose,
    sendOrdinal,
    ...rest
  } = options;
  return getLinearHarnessAgentProvider().sendAndObserve({
    agent,
    prompt,
    runDirectory,
    events,
    launchContext,
    providerRunOperationId,
    sendPurpose,
    sendOrdinal,
    options: rest,
  });
}

export async function disposeAgent(agent: AgentHandle): Promise<void> {
  return getLinearHarnessAgentProvider().disposeAgent(agent);
}

export { downloadAgentReviewArtifacts } from "./index.js";

export type { CursorCancelOutcome, ObservedAgentRun, AgentHandle } from "./types.js";
