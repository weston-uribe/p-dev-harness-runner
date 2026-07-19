export interface LangfuseInspectObservation {
  id: string;
  name: string | null;
  type: string | null;
  startTime: string | null;
  endTime: string | null;
  model: string | null;
  hasInput: boolean;
  hasOutput: boolean;
  inputByteCount: number | null;
  outputByteCount: number | null;
  inputSha256: string | null;
  outputSha256: string | null;
  usage: Record<string, number> | null;
  costUsd: number | null;
  costSource: string | null;
  costUnavailableReason: string | null;
  pricingRegistryVersion: string | null;
  promptName: string | null;
  promptContractVersion: string | null;
  skillIds: string[];
  skillProvenanceStatus: string | null;
  toolCount: number;
  agentId: string | null;
  cursorRunId: string | null;
  linearIssueKey: string | null;
  phase: string | null;
  phaseExecutionId: string | null;
  harnessRunId: string | null;
  revisionCycleIndex: number | null;
  metadata: Record<string, unknown>;
}

export interface LangfuseInspectScore {
  id: string;
  name: string;
  traceId: string | null;
  sessionId: string | null;
  observationId: string | null;
  dataType: string | null;
  value: unknown;
  timestamp: string | null;
}

export interface LangfuseInspectTrace {
  id: string;
  name: string | null;
  sessionId: string | null;
  timestamp: string | null;
  linearIssueKey: string | null;
  phase: string | null;
  phaseExecutionId: string | null;
  harnessRunId: string | null;
  revisionCycleIndex: number | null;
  hasInput: boolean;
  hasOutput: boolean;
  observations: LangfuseInspectObservation[];
  scores: LangfuseInspectScore[];
  issueIdentityMissing: boolean;
}

export interface LangfuseInspectGap {
  code: string;
  severity: "error" | "warning";
  message: string;
  traceId?: string;
  observationId?: string;
  /** Bounded normalized reason used for gap identity (not the human message). */
  reasonCode?: string;
}

export type GenerationExclusionReason =
  | "not_associated_with_expected_phase"
  | "unnamed_without_durable_phase_correlation"
  | "non_generation_container";

export interface LangfuseInspectReport {
  schemaVersion: 1;
  issueKey: string;
  namespace: string;
  sessionId: string;
  sessionDisplayName: string | null;
  inspectedAt: string;
  expectedPhases: string[];
  traces: LangfuseInspectTrace[];
  scores: LangfuseInspectScore[];
  gaps: LangfuseInspectGap[];
  acceptance: {
    /** Private core acceptance — does not include public-summary privacy validation. */
    coreComplete: boolean;
    /**
     * Private/local alias of coreComplete (does not include privacy).
     * Public workflow must use LangfuseInspectPublicSummary.acceptance.complete.
     */
    complete: boolean;
    missingVisibleIssueKey: boolean;
    hasPlanningTrace: boolean;
    hasPlannerAgent: boolean;
    hasPlanReviewTrace: boolean;
    hasPlanReviewerAgent: boolean;
    requiredTracesPresent: boolean;
    requiredAgentsPresent: boolean;
    requiredGenerationsPresent: boolean;
    planningTraceNames: string[];
    plannerAgentNames: string[];
    planReviewTraceNames: string[];
    planReviewerAgentNames: string[];
    agentObservationNames: string[];
    generationCostComplete: boolean;
    requiredGenerationCount: number;
    costCompleteGenerationCount: number;
    incompleteRequiredGenerationCount: number;
    uniqueGenerationCandidateCount: number;
    excludedGenerationCandidateCount: number;
    errorGapCount: number;
    warningGapCount: number;
    scoreNames: string[];
  };
  artifactComparison: {
    localRunCount: number;
    conflictingCorrelations: Array<{
      traceId: string;
      field: string;
      langfuseValue: unknown;
      artifactValue: unknown;
    }>;
  };
  safeContent?: {
    observations: Array<{
      id: string;
      inputSha256: string | null;
      outputSha256: string | null;
      inputByteCount: number | null;
      outputByteCount: number | null;
      redactionStatus: string | null;
    }>;
  };
}

/** Allowlisted public Actions artifact — no private identifiers or messages. */
export interface LangfuseInspectPublicSummary {
  schemaVersion: 1;
  kind: "langfuse_inspect_public_summary";
  requestId: string | null;
  githubRunId: string | null;
  inspectedAt: string;
  expectedPhaseCount: number;
  traceCount: number;
  uniqueGenerationCount: number;
  requiredGenerationCount: number;
  costCompleteGenerationCount: number;
  incompleteRequiredGenerationCount: number;
  errorGapCount: number;
  warningGapCount: number;
  gapCodeCounts: Record<string, number>;
  privacyValidationPassed: boolean;
  acceptance: {
    coreComplete: boolean;
    generationCostComplete: boolean;
    privacyValidationPassed: boolean;
    requiredGenerationCount: number;
    incompleteRequiredGenerationCount: number;
    errorGapCount: number;
    complete: boolean;
  };
}
