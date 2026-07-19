import type { EvaluationSubject, EvaluationSubjectType } from "../subjects/types.js";
import { LANGFUSE_SUBJECT_MAPPING } from "../annotations/langfuse-adapter.js";
import type { EvaluatorResult } from "./types.js";

/**
 * Export mapping for deterministic results to future Langfuse scores.
 * No live synchronization in this slice.
 */

export interface LangfuseEvaluatorExportRecord {
  schemaVersion: 1;
  localEvaluatorResultId: string;
  evaluationSubjectId: string;
  langfuseSessionId: string | null;
  langfuseTraceId: string | null;
  langfuseObservationId: string | null;
  evaluatorId: string;
  evaluatorVersion: string;
  evaluatorImplementationHash: string;
  rubricId: string;
  rubricVersion: string;
  dimensionId: string;
  status: EvaluatorResult["status"];
  result: EvaluatorResult["result"];
  skipReason: EvaluatorResult["skipReason"];
  reasonCode: string;
  comment: string;
  createdAt: string;
}

export interface LangfuseEvaluatorExportArtifact {
  schemaVersion: 1;
  exportedAt: string;
  issueKey: string;
  evaluationSessionId: string;
  mappingRules: typeof LANGFUSE_SUBJECT_MAPPING;
  records: LangfuseEvaluatorExportRecord[];
  importIdempotencyNotes: string[];
  skippedAndErrorHandlingNotes: string[];
}

function mapSubjectTargets(
  subjectType: EvaluationSubjectType,
  subject: EvaluationSubject,
): {
  langfuseSessionId: string | null;
  langfuseTraceId: string | null;
  langfuseObservationId: string | null;
} {
  const rule = LANGFUSE_SUBJECT_MAPPING.find((r) => r.subjectType === subjectType);
  if (!rule) {
    return {
      langfuseSessionId: null,
      langfuseTraceId: null,
      langfuseObservationId: null,
    };
  }
  if (rule.targetKind === "session") {
    return {
      langfuseSessionId: subject.evaluationSessionId,
      langfuseTraceId: null,
      langfuseObservationId: null,
    };
  }
  if (rule.targetKind === "trace") {
    return {
      langfuseSessionId: subject.evaluationSessionId,
      langfuseTraceId: subject.phaseExecutionId,
      langfuseObservationId: null,
    };
  }
  return {
    langfuseSessionId: subject.evaluationSessionId,
    langfuseTraceId: subject.phaseExecutionId,
    langfuseObservationId: subject.agentRunId ?? subject.toolCallId,
  };
}

export function buildLangfuseEvaluatorExport(params: {
  issueKey: string;
  evaluationSessionId: string;
  subjects: EvaluationSubject[];
  results: EvaluatorResult[];
  now?: () => string;
}): LangfuseEvaluatorExportArtifact {
  const now = params.now ?? (() => new Date().toISOString());
  const bySubject = new Map(
    params.subjects.map((s) => [s.evaluationSubjectId, s] as const),
  );
  const records: LangfuseEvaluatorExportRecord[] = [];
  for (const result of params.results) {
    const subject = bySubject.get(result.evaluationSubjectId);
    const targets = subject
      ? mapSubjectTargets(subject.subjectType, subject)
      : {
          langfuseSessionId: null,
          langfuseTraceId: null,
          langfuseObservationId: null,
        };
    records.push({
      schemaVersion: 1,
      localEvaluatorResultId: result.evaluatorResultId,
      evaluationSubjectId: result.evaluationSubjectId,
      ...targets,
      evaluatorId: result.evaluatorId,
      evaluatorVersion: result.evaluatorVersion,
      evaluatorImplementationHash: result.evaluatorImplementationHash,
      rubricId: result.rubricId,
      rubricVersion: result.rubricVersion,
      dimensionId: result.dimensionId,
      status: result.status,
      result: result.result,
      skipReason: result.skipReason,
      reasonCode: result.reasonCode,
      comment: result.explanation,
      createdAt: result.completedAt,
    });
  }
  return {
    schemaVersion: 1,
    exportedAt: now(),
    issueKey: params.issueKey,
    evaluationSessionId: params.evaluationSessionId,
    mappingRules: LANGFUSE_SUBJECT_MAPPING,
    records,
    importIdempotencyNotes: [
      "Use localEvaluatorResultId as the Langfuse score idempotency key.",
      "Do not mix evaluator exports into human annotation import paths.",
    ],
    skippedAndErrorHandlingNotes: [
      "skipped results may be imported as null scores with metadata skipReason/reasonCode.",
      "error results must not be treated as contract failures in Langfuse without local review.",
      "pass/fail map to boolean score values when result is boolean.",
    ],
  };
}
