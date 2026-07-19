/**
 * Provider-neutral observability contracts for Complete Session v1.
 * Langfuse is a replaceable projection of these records.
 */

import type { AgentTelemetryPhase } from "../telemetry/types.js";
import type { AgentDisplayRole } from "../naming.js";

export const OBSERVABILITY_CONTRACT_VERSION = 1 as const;

export interface EvaluationSessionContext {
  contractVersion: typeof OBSERVABILITY_CONTRACT_VERSION;
  evaluationSessionId: string;
  /** Human-readable session display (Linear issue key). */
  sessionDisplayName: string;
  linearIssueKey: string;
  linearTeamKey: string | null;
  namespace: string;
}

export interface PhaseExecutionContext {
  contractVersion: typeof OBSERVABILITY_CONTRACT_VERSION;
  evaluationSessionId: string;
  harnessRunId: string;
  phaseExecutionId: string;
  phase: AgentTelemetryPhase;
  linearIssueKey: string;
  linearTeamKey: string | null;
  revisionCycleIndex: number | null;
  /** Human-readable phase trace display name. */
  displayName: string;
  /** Stable machine key for schema continuity, e.g. p-dev.planning */
  machineTraceKey: string;
}

export interface AgentExecutionContext {
  contractVersion: typeof OBSERVABILITY_CONTRACT_VERSION;
  evaluationSessionId: string;
  harnessRunId: string;
  phaseExecutionId: string;
  phase: AgentTelemetryPhase;
  role: AgentDisplayRole;
  linearIssueKey: string;
  displayName: string;
  cursorAgentId: string | null;
  cursorRunId: string | null;
  cursorRequestId: string | null;
}

export interface PromptAssemblyComponent {
  componentId: string;
  kind: "template" | "skill" | "issue_context" | "planner_context" | "pm_feedback" | "other";
  sourcePath: string | null;
  contentSha256: string | null;
  byteCount: number | null;
  included: boolean;
}

export interface PromptAssemblyManifest {
  contractVersion: typeof OBSERVABILITY_CONTRACT_VERSION;
  promptAssemblySchemaVersion: 1;
  promptName: string;
  promptContractVersion: string;
  promptTemplateSourcePath: string;
  promptTemplateSha256: string;
  renderedPromptSha256: string;
  renderedByteCount: number;
  orderedComponents: PromptAssemblyComponent[];
  phase: AgentTelemetryPhase;
  role: AgentDisplayRole | null;
  linearIssueKey: string;
  harnessRunId: string;
  phaseExecutionId: string;
  plannerContextIncluded: boolean;
  pmFeedbackIncluded: boolean;
}

export type SkillInclusionMethod =
  | "rendered_into_prompt"
  | "referenced_by_prompt"
  | "provider_native"
  | "none";

export interface SkillProvenanceEntry {
  skillId: string;
  role: string;
  sourcePath: string;
  contentSha256: string;
  skillContractVersion: string | null;
  inclusionMethod: SkillInclusionMethod;
}

export interface SkillProvenanceManifest {
  contractVersion: typeof OBSERVABILITY_CONTRACT_VERSION;
  skillProvenanceStatus: "present" | "none";
  skillsUsed: SkillProvenanceEntry[];
  phase: AgentTelemetryPhase;
  linearIssueKey: string;
  harnessRunId: string;
  phaseExecutionId: string;
}

export type CostUnavailableReason =
  | "provider_did_not_report"
  | "missing_pricing_entry"
  | "usage_unavailable"
  | "billing_api_unavailable";

export interface UsageAndCostRecord {
  contractVersion: typeof OBSERVABILITY_CONTRACT_VERSION;
  modelId: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  reasoningTokens: number | null;
  costSource: "provider" | "pricing_registry" | "unavailable";
  /** Trustworthy numeric USD cost when available. */
  costUsd: number | null;
  costUnavailableReason: CostUnavailableReason | null;
  pricingRegistryVersion: string | null;
  usageAggregation: "cursor_run_aggregate" | "cursor_turn" | null;
  individualModelCallsAvailable: boolean;
}

export interface EvaluationScoreRecord {
  contractVersion: typeof OBSERVABILITY_CONTRACT_VERSION;
  scoreId: string;
  name: string;
  target: "trace" | "session";
  dataType: "BOOLEAN" | "NUMERIC" | "CATEGORICAL";
  value: boolean | number | string;
  timestamp: string;
  scoreClass: "operational";
  linearIssueKey: string;
  harnessRunId: string | null;
  phaseExecutionId: string | null;
}

export interface TelemetryCompletenessRecord {
  contractVersion: typeof OBSERVABILITY_CONTRACT_VERSION;
  inputCaptured: boolean;
  outputCaptured: boolean;
  modelCaptured: boolean;
  usageCaptured: boolean;
  promptProvenanceCaptured: boolean;
  skillProvenanceCaptured: boolean;
  toolCompletionRate: number | null;
  linearIssueKey: string;
  harnessRunId: string;
  phaseExecutionId: string;
}

/** Allowlisted identity fields projected onto Langfuse entities. */
export interface IssueIdentityFields {
  linearIssueKey: string;
  linearTeamKey: string | null;
  phase: string;
  phaseExecutionId: string;
  revisionCycleIndex: number | null;
  harnessRunId: string;
}

export function buildIssueIdentityFields(
  params: IssueIdentityFields,
): Record<string, unknown> {
  return {
    linearIssueKey: params.linearIssueKey,
    linearTeamKey: params.linearTeamKey,
    phase: params.phase,
    phaseExecutionId: params.phaseExecutionId,
    revisionCycleIndex: params.revisionCycleIndex,
    harnessRunId: params.harnessRunId,
  };
}
