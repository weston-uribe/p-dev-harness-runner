/**
 * Provider-neutral agent telemetry schema (Rich Execution Telemetry v1).
 * Canonical source of truth is local JSONL; Langfuse is a projection adapter.
 */

export const AGENT_TELEMETRY_SCHEMA_VERSION = 1 as const;

export type AgentTelemetryProvider = "cursor";

export type AgentTelemetryPhase =
  | "planning"
  | "plan_review"
  | "code_review"
  | "code_revision"
  | "implementation"
  | "handoff"
  | "revision"
  | "merge"
  | "integration_repair";

export type RedactionStatus =
  | "none"
  | "redacted"
  | "bounded"
  | "redacted_and_bounded"
  | "reference_only";

export type ArtifactKind =
  | "rendered_prompt"
  | "agent_output"
  | "pm_feedback"
  | "cursor_run_result"
  | "other";

export interface ArtifactRef {
  artifactKind: ArtifactKind;
  /** Path relative to the run directory. */
  artifactPath: string;
  sha256: string;
  byteCount: number;
  redactionStatus: RedactionStatus;
}

export type CostSource = "provider" | "pricing_registry" | "unavailable";

export type CostUnavailableReason =
  | "provider_did_not_report"
  | "missing_pricing_entry"
  | "usage_unavailable"
  | "billing_api_unavailable";

export interface AgentCostRecord {
  providerReportedCostUsd?: number;
  estimatedCostUsd?: number;
  costSource: CostSource;
  pricingRegistryVersion?: string;
  /** Required when costSource is unavailable — bare unavailable is incomplete. */
  costUnavailableReason?: CostUnavailableReason;
}

export interface AgentUsageRecord {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  cost: AgentCostRecord;
}

export type ToolMutationClass = "mutation" | "read_only" | "unknown";

export type ToolCallStatus = "started" | "completed" | "error" | "incomplete";

export interface SkillProvenanceRecord {
  skillId: string;
  sourcePath: string;
  role: string;
  contentSha256: string;
}

/** Required correlation fields — independent of Langfuse. */
export interface AgentTelemetryEnvelope {
  schemaVersion: typeof AGENT_TELEMETRY_SCHEMA_VERSION;
  eventId: string;
  evaluationSessionId: string;
  harnessRunId: string;
  phaseExecutionId: string;
  phase: AgentTelemetryPhase;
  provider: AgentTelemetryProvider;
  timestamp: string;
  /** Optional provider / adapter IDs */
  providerTraceId?: string;
  providerObservationId?: string;
  cursorAgentId?: string;
  cursorRunId?: string;
  cursorRequestId?: string;
}

export type AgentTelemetryEventKind =
  | "agent_run_started"
  | "agent_run_finished"
  | "assistant_output"
  | "model_usage"
  | "tool_call_started"
  | "tool_call_finished"
  | "tool_result"
  | "error"
  | "retry"
  | "cancellation"
  | "prompt_provenance"
  | "skill_provenance"
  | "pm_feedback"
  | "timing_milestone"
  | "telemetry_completeness";

export interface AgentTelemetryCompleteness {
  trace_input_present: boolean;
  trace_output_present: boolean;
  agent_input_present: boolean;
  agent_output_present: boolean;
  model_present: boolean;
  usage_present: boolean;
  tool_events_present: boolean;
  tool_event_completion_rate: number | null;
  prompt_provenance_present: boolean;
  skill_provenance_present: boolean;
  pm_feedback_present: boolean | null;
}

export interface AgentTelemetryEventCounts {
  total: number;
  byKind: Partial<Record<AgentTelemetryEventKind, number>>;
  toolStarted: number;
  toolFinished: number;
  toolError: number;
  toolIncomplete: number;
}

export type AgentTelemetryEvent = AgentTelemetryEnvelope & {
  kind: AgentTelemetryEventKind;
  /** Kind-specific payload (bounded / redacted / refs). */
  payload: Record<string, unknown>;
};

export type OnTelemetryEvent = (
  event: AgentTelemetryEvent,
) => void | Promise<void>;

export interface TelemetryCorrelationContext {
  evaluationSessionId: string;
  harnessRunId: string;
  phaseExecutionId: string;
  phase: AgentTelemetryPhase;
  provider: AgentTelemetryProvider;
  providerTraceId?: string;
  cursorAgentId?: string;
  cursorRunId?: string;
  cursorRequestId?: string;
}
