import {
  EVALUATION_SUBJECT_SCHEMA_VERSION,
  type EvaluationSubject,
  type EvaluationSubjectPhase,
  type EvaluationSubjectType,
  type PrivacyStatusAtCapture,
} from "./types.js";

const SUBJECT_TYPES: EvaluationSubjectType[] = [
  "phase_execution",
  "revision_cycle",
  "workflow_session",
  "agent_run",
  "tool_call",
];

const PHASES: EvaluationSubjectPhase[] = [
  "planning",
  "implementation",
  "handoff",
  "revision",
  "integration_repair",
  "merge",
];

const PRIVACY: PrivacyStatusAtCapture[] = [
  "metadata_v1",
  "content_v1",
  "local_only",
  "unknown",
];

export function validateEvaluationSubject(
  value: unknown,
): value is EvaluationSubject {
  if (!value || typeof value !== "object") return false;
  const s = value as Record<string, unknown>;
  if (s.evaluationSubjectSchemaVersion !== EVALUATION_SUBJECT_SCHEMA_VERSION) {
    return false;
  }
  if (typeof s.evaluationSubjectId !== "string" || !s.evaluationSubjectId) {
    return false;
  }
  if (
    typeof s.subjectType !== "string" ||
    !SUBJECT_TYPES.includes(s.subjectType as EvaluationSubjectType)
  ) {
    return false;
  }
  if (typeof s.evaluationSessionId !== "string" || !s.evaluationSessionId) {
    return false;
  }
  if (typeof s.issueKey !== "string" || !s.issueKey) return false;
  if (s.harnessRunId !== null && typeof s.harnessRunId !== "string") return false;
  if (
    s.phase !== null &&
    (typeof s.phase !== "string" ||
      !PHASES.includes(s.phase as EvaluationSubjectPhase))
  ) {
    return false;
  }
  if (
    s.phaseExecutionId !== null &&
    typeof s.phaseExecutionId !== "string"
  ) {
    return false;
  }
  if (
    s.revisionCycleIndex !== null &&
    typeof s.revisionCycleIndex !== "number"
  ) {
    return false;
  }
  if (
    s.pmFeedbackCommentId !== null &&
    typeof s.pmFeedbackCommentId !== "string"
  ) {
    return false;
  }
  if (s.agentId !== null && typeof s.agentId !== "string") return false;
  if (s.agentRunId !== null && typeof s.agentRunId !== "string") return false;
  if (s.toolCallId !== null && typeof s.toolCallId !== "string") return false;
  if (!Array.isArray(s.evidenceArtifactRefs)) return false;
  if (!Array.isArray(s.missingEvidence)) return false;
  if (typeof s.evidenceComplete !== "boolean") return false;
  if (
    typeof s.privacyStatusAtCapture !== "string" ||
    !PRIVACY.includes(s.privacyStatusAtCapture as PrivacyStatusAtCapture)
  ) {
    return false;
  }
  if (typeof s.createdAt !== "string" || !s.createdAt) return false;
  return true;
}

export function assertEvaluationSubject(value: unknown): EvaluationSubject {
  if (!validateEvaluationSubject(value)) {
    throw new Error("Invalid evaluation subject record");
  }
  return value;
}
