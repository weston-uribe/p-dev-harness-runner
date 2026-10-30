import type { HarnessConfig } from "../config/types.js";
import type { EventLogger } from "../artifacts/events.js";
import type { LinearCommentRecord } from "../linear/writer.js";
import type {
  BuilderThreadResolution,
  BuilderThreadSourcePhase,
} from "../runner/builder-thread-types.js";
import type {
  AgentCostRecord,
  AgentTelemetryCompleteness,
  AgentTelemetryEventCounts,
  ArtifactRef,
  OnTelemetryEvent,
  TelemetryCorrelationContext,
} from "../evaluation/telemetry/types.js";

export type AgentObservePhase =
  | "planning"
  | "plan_review"
  | "implementation"
  | "code_review"
  | "code_revision"
  | "revision"
  | "integration_repair";

export type CursorCancelOutcome =
  | "cancelled"
  | "cancel_unavailable"
  | "cancel_failed";

export interface CapturedGitResult {
  repoUrl: string;
  branch: string;
  prUrl: string;
}

export interface ObservedAgentUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  cost: AgentCostRecord;
}

export interface ObservedAgentRun {
  agentId: string;
  runId: string;
  requestId?: string;
  assistantText: string;
  gitResult: CapturedGitResult | null;
  cancelOutcome: CursorCancelOutcome | null;
  /** Allowlisted Cursor completion fields for evaluation (optional). */
  status?: string;
  durationMs?: number | null;
  /** Actual model returned by Cursor when present. */
  model?: { id: string; params?: Array<{ id: string; value: string }> } | null;
  usage?: ObservedAgentUsage | null;
  /** References to local artifacts (prompt/output/run-result) — not event bodies. */
  artifactRefs?: ArtifactRef[];
  eventCounts?: AgentTelemetryEventCounts;
  completeness?: AgentTelemetryCompleteness;
}

export interface AgentHandle {
  readonly __brand: unique symbol;
}

export interface PlanningAgentParams {
  apiKey: string;
  config: HarnessConfig;
  targetRepo: string;
  baseBranch: string;
}

export type ImplementationAgentParams = PlanningAgentParams;

export interface BranchAgentParams {
  apiKey: string;
  config: HarnessConfig;
  targetRepo: string;
  branch: string;
  prUrl: string;
}

export type RevisionAgentParams = BranchAgentParams;
export type IntegrationRepairAgentParams = BranchAgentParams;
export type CodeReviewAgentParams = BranchAgentParams;
export type CodeRevisionAgentParams = BranchAgentParams;

export interface AgentModelSelection {
  id: string;
}

export interface SendAndObserveOptions {
  phase?: AgentObservePhase;
  targetRepo?: string;
  expectedBranch?: string;
  expectedPrUrl?: string;
  abortSignal?: AbortSignal;
  apiKey?: string;
  pollIntervalMs?: number;
  model?: AgentModelSelection;
  mode?: "agent" | "plan";
  idempotencyKey?: string;
  onAgentCreated?: (details: { agentId: string; runId: string }) => Promise<void>;
  onBeforeSend?: (details: { agentId: string }) => Promise<void>;
  onRunAcknowledged?: (details: {
    agentId: string;
    runId: string;
    acknowledgedAt: string;
    providerRunCreatedAt?: string | null;
  }) => Promise<void>;
  onRunTerminal?: (details: {
    agentId: string;
    runId: string;
    terminalStatus: string;
    terminalAt: string;
    providerTerminalAt?: string | null;
    hasAuthoritativeTerminalResult: true;
  }) => Promise<void>;
  /** Provider-neutral streaming telemetry callback (local JSONL + Langfuse). */
  onTelemetryEvent?: OnTelemetryEvent;
  /** Correlation context for canonical telemetry (required for JSONL capture). */
  telemetryCorrelation?: TelemetryCorrelationContext;
  revisionRequiresPmFeedback?: boolean;
}

export interface BuilderProvenanceMutationHooks {
  beforeMutation(info: {
    action: "create" | "resume" | "replacement";
    generation: number;
    priorAgentId?: string;
  }): Promise<void>;
  afterAgent(info: {
    action: "create" | "resume" | "replacement";
    agentId: string;
    generation: number;
    priorAgentId?: string;
  }): Promise<void>;
  onMutationFailed?(info: {
    action: "create" | "resume" | "replacement";
    error: unknown;
  }): Promise<void>;
}

export interface AcquireBuilderAgentParams {
  apiKey: string;
  config: HarnessConfig;
  phase: BuilderThreadSourcePhase;
  context: {
    issueKey: string;
    harnessRunId: string;
    targetRepo: string;
    baseBranch: string;
    branch?: string;
    prUrl?: string;
    idempotencyKey: string;
    comments: LinearCommentRecord[];
    orchestratorMarker: string;
    previousImplementationRunId?: string;
    previousRevisionRunId?: string;
    workflowState?: {
      builderAgentId?: string | null;
      builderRunId?: string | null;
      issueKey?: string;
    } | null;
  };
  events: EventLogger;
  /** Optional for tests/nonproduction; production wrapper always supplies one. */
  provenanceHooks?: BuilderProvenanceMutationHooks;
}

export interface AcquiredBuilderAgent {
  agent: AgentHandle;
  continuity: BuilderThreadResolution;
}

export interface AgentProvider {
  readonly id: "cursor";

  resolveModelId(config: HarnessConfig): string;

  createPlanningAgent(params: PlanningAgentParams): Promise<AgentHandle>;
  createPlanReviewAgent(params: PlanningAgentParams): Promise<AgentHandle>;
  /** Resume an existing Plan Reviewer agent when durable agent id is present. */
  resumePlanReviewAgent?(input: {
    apiKey: string;
    agentId: string;
  }): Promise<AgentHandle>;
  createCodeReviewAgent(params: CodeReviewAgentParams): Promise<AgentHandle>;
  createCodeRevisionAgent(params: CodeRevisionAgentParams): Promise<AgentHandle>;
  createImplementationAgent(params: ImplementationAgentParams): Promise<AgentHandle>;
  acquireBuilderAgent(params: AcquireBuilderAgentParams): Promise<AcquiredBuilderAgent>;

  sendAndObserve(
    agent: AgentHandle,
    prompt: string,
    runDirectory: string,
    events: EventLogger,
    options?: SendAndObserveOptions,
  ): Promise<ObservedAgentRun>;

  disposeAgent(agent: AgentHandle): Promise<void>;
}
