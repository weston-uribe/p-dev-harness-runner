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
}

export interface LangfuseInspectReport {
  schemaVersion: 1;
  issueKey: string;
  namespace: string;
  sessionId: string;
  sessionDisplayName: string | null;
  inspectedAt: string;
  traces: LangfuseInspectTrace[];
  scores: LangfuseInspectScore[];
  gaps: LangfuseInspectGap[];
  acceptance: {
    complete: boolean;
    missingVisibleIssueKey: boolean;
    hasPlanningTrace: boolean;
    hasPlannerAgent: boolean;
    planningTraceNames: string[];
    plannerAgentNames: string[];
    agentObservationNames: string[];
    generationCostComplete: boolean;
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
