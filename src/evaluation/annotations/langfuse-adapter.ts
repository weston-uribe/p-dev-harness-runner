import type { EvaluationSubjectType } from "../subjects/types.js";
import type { HumanAnnotation } from "./types.js";

/**
 * Provider-neutral mapping contract for future local ↔ Langfuse annotation sync.
 * No live synchronization in this slice.
 */

export type LangfuseAnnotationTargetKind =
  | "session"
  | "trace"
  | "observation";

export interface LangfuseSubjectMappingRule {
  subjectType: EvaluationSubjectType;
  targetKind: LangfuseAnnotationTargetKind;
  notes: string;
}

export const LANGFUSE_SUBJECT_MAPPING: LangfuseSubjectMappingRule[] = [
  {
    subjectType: "workflow_session",
    targetKind: "session",
    notes: "Maps to Langfuse session via evaluationSessionId.",
  },
  {
    subjectType: "phase_execution",
    targetKind: "trace",
    notes:
      "Maps to phase trace when present; local phaseExecutionId remains canonical.",
  },
  {
    subjectType: "revision_cycle",
    targetKind: "trace",
    notes:
      "Maps to the revision phase trace that addressed the PM feedback comment.",
  },
  {
    subjectType: "agent_run",
    targetKind: "observation",
    notes: "Maps to agent observation under the phase trace when available.",
  },
  {
    subjectType: "tool_call",
    targetKind: "observation",
    notes: "Maps to tool observation; structural only in v1 human review.",
  },
];

export interface LangfuseAnnotationExportRecord {
  schemaVersion: 1;
  localAnnotationId: string;
  evaluationSubjectId: string;
  langfuseSessionId: string | null;
  langfuseTraceId: string | null;
  langfuseObservationId: string | null;
  rubricId: string;
  rubricVersion: string;
  dimensionId: string;
  judgmentStatus: HumanAnnotation["judgmentStatus"];
  scoreValue: HumanAnnotation["value"] | null;
  reviewerComment: string | null;
  correctedOutputArtifactPath: string | null;
  source: HumanAnnotation["source"];
  createdAt: string;
}

export interface LangfuseAnnotationExportArtifact {
  schemaVersion: 1;
  exportedAt: string;
  issueKey: string;
  evaluationSessionId: string;
  mappingRules: LangfuseSubjectMappingRule[];
  records: LangfuseAnnotationExportRecord[];
  importIdempotencyNotes: string[];
  reconciliationNotes: string[];
}

export function buildLangfuseAnnotationExport(params: {
  issueKey: string;
  evaluationSessionId: string;
  annotations: HumanAnnotation[];
  subjectLookup: Map<
    string,
    {
      subjectType: EvaluationSubjectType;
      langfuseSessionId?: string | null;
      langfuseTraceId?: string | null;
      langfuseObservationId?: string | null;
    }
  >;
  now?: () => string;
}): LangfuseAnnotationExportArtifact {
  const now = params.now ?? (() => new Date().toISOString());
  const records: LangfuseAnnotationExportRecord[] = [];

  for (const annotation of params.annotations) {
    if (annotation.status !== "submitted") continue;
    const subject = params.subjectLookup.get(annotation.evaluationSubjectId);
    records.push({
      schemaVersion: 1,
      localAnnotationId: annotation.annotationId,
      evaluationSubjectId: annotation.evaluationSubjectId,
      langfuseSessionId: subject?.langfuseSessionId ?? params.evaluationSessionId,
      langfuseTraceId: subject?.langfuseTraceId ?? null,
      langfuseObservationId: subject?.langfuseObservationId ?? null,
      rubricId: annotation.rubricId,
      rubricVersion: annotation.rubricVersion,
      dimensionId: annotation.dimensionId,
      judgmentStatus: annotation.judgmentStatus,
      scoreValue:
        annotation.judgmentStatus === "scored" ? (annotation.value ?? null) : null,
      reviewerComment: annotation.reviewerComment ?? null,
      correctedOutputArtifactPath:
        annotation.correctedOutputArtifactRef?.artifactPath ?? null,
      source: annotation.source,
      createdAt: annotation.createdAt,
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
      "Use localAnnotationId as the Langfuse import idempotency key.",
      "Retries with the same localAnnotationId must not create duplicate Langfuse scores/annotations.",
      "Preserve imported annotation IDs when reconciling Langfuse → local via preserveAnnotationId.",
    ],
    reconciliationNotes: [
      "Local annotations.jsonl remains canonical.",
      "Langfuse-originated labels import as source=human_langfuse without requiring Langfuse to create local rows first.",
      "Supersession/invalidation are derived locally; do not mutate historical local rows during import.",
      "Deterministic evaluator and LLM judge outputs must use EvaluatorResult, never HumanAnnotation.source.",
    ],
  };
}
