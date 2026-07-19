import type { ArtifactRef } from "../telemetry/types.js";
import type { AgentTelemetryCompleteness } from "../telemetry/types.js";

export const EVALUATION_SUBJECT_SCHEMA_VERSION = 1 as const;
export const SUBJECT_EXTRACTION_POLICY_VERSION = "subject-extraction-v1" as const;

export type EvaluationSubjectType =
  | "phase_execution"
  | "revision_cycle"
  | "workflow_session"
  | "agent_run"
  | "tool_call";

export type EvaluationSubjectPhase =
  | "planning"
  | "implementation"
  | "handoff"
  | "revision"
  | "integration_repair"
  | "merge";

export type PrivacyStatusAtCapture =
  | "metadata_v1"
  | "content_v1"
  | "local_only"
  | "unknown";

export interface EvaluationSubject {
  evaluationSubjectSchemaVersion: typeof EVALUATION_SUBJECT_SCHEMA_VERSION;
  evaluationSubjectId: string;
  subjectType: EvaluationSubjectType;
  evaluationSessionId: string;
  issueKey: string;
  harnessRunId: string | null;
  phase: EvaluationSubjectPhase | null;
  phaseExecutionId: string | null;
  /** Descriptive only — never used as canonical identity. */
  revisionCycleIndex: number | null;
  pmFeedbackCommentId: string | null;
  agentId: string | null;
  agentRunId: string | null;
  toolCallId: string | null;
  evidenceArtifactRefs: ArtifactRef[];
  missingEvidence: string[];
  evidenceComplete: boolean;
  telemetryCompletenessSummary: Partial<AgentTelemetryCompleteness> | null;
  privacyStatusAtCapture: PrivacyStatusAtCapture;
  createdAt: string;
  sourceHarnessRelease: string | null;
  sourceHarnessCommit: string | null;
  promptContractVersion: string | null;
  modelId: string | null;
}

export interface SubjectExtractionDiagnostic {
  code: string;
  message: string;
  harnessRunId?: string;
  phase?: string;
  details?: Record<string, unknown>;
}

export interface SubjectExtractionReport {
  schemaVersion: 1;
  extractionPolicyVersion: typeof SUBJECT_EXTRACTION_POLICY_VERSION;
  evaluationSessionId: string;
  issueKey: string;
  namespace: string;
  computedAt: string;
  runsScanned: number;
  runsSkipped: Array<{ runDirectory: string; reason: string }>;
  subjectsEmittedByType: Record<EvaluationSubjectType, number>;
  missingOrMalformedEvidence: SubjectExtractionDiagnostic[];
  revisionRunsMissingFeedbackIdentity: string[];
  telemetryParsingWarnings: SubjectExtractionDiagnostic[];
  duplicateIdentitiesResolved: number;
  diagnostics: SubjectExtractionDiagnostic[];
}

export interface ExtractSubjectsResult {
  subjects: EvaluationSubject[];
  report: SubjectExtractionReport;
  evaluationDirectory: string;
}
