import type { EvaluationRubric, RubricDimension } from "../rubrics/types.js";
import {
  ANNOTATION_SCHEMA_VERSION,
  type AnnotationValue,
  type HumanAnnotation,
  type JudgmentStatus,
} from "./types.js";

const SOURCES = new Set(["human_local", "human_langfuse"]);
const STATUSES = new Set(["draft", "submitted"]);
const JUDGMENTS = new Set([
  "scored",
  "insufficient_evidence",
  "not_applicable",
]);

export function isFiniteConfidence(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

export function valueAllowedForDimension(
  dimension: RubricDimension,
  value: AnnotationValue,
): boolean {
  switch (dimension.responseType) {
    case "boolean":
      return typeof value === "boolean";
    case "free_text":
      return typeof value === "string" && value.length > 0;
    case "numeric": {
      if (typeof value !== "number" || !Number.isFinite(value)) return false;
      if (
        typeof dimension.numericMin === "number" &&
        value < dimension.numericMin
      ) {
        return false;
      }
      if (
        typeof dimension.numericMax === "number" &&
        value > dimension.numericMax
      ) {
        return false;
      }
      return true;
    }
    case "ordinal":
    case "categorical":
      return (
        dimension.allowedValues?.some((allowed) => allowed === value) ?? false
      );
    default:
      return false;
  }
}

export function validateAnnotationAgainstRubric(params: {
  annotation: HumanAnnotation;
  rubric: EvaluationRubric;
}): string[] {
  const errors: string[] = [];
  const { annotation, rubric } = params;
  if (annotation.rubricId !== rubric.rubricId) {
    errors.push("rubricId mismatch");
  }
  if (annotation.rubricVersion !== rubric.rubricVersion) {
    errors.push("rubricVersion mismatch");
  }
  const dimension = rubric.dimensions.find(
    (d) => d.dimensionId === annotation.dimensionId,
  );
  if (!dimension) {
    errors.push(`unknown dimensionId: ${annotation.dimensionId}`);
    return errors;
  }

  if (annotation.judgmentStatus === "scored") {
    if (annotation.value === undefined) {
      errors.push("value required when judgmentStatus is scored");
    } else if (!valueAllowedForDimension(dimension, annotation.value)) {
      errors.push("value not allowed for dimension");
    }
  } else if (annotation.value !== undefined) {
    errors.push(
      `value prohibited when judgmentStatus is ${annotation.judgmentStatus}`,
    );
  }

  const unscoredNeedsComment =
    annotation.judgmentStatus !== "scored" &&
    (dimension.unscoredCommentRequired ?? false);
  if (
    (dimension.reviewerCommentRequired || unscoredNeedsComment) &&
    !annotation.reviewerComment?.trim()
  ) {
    errors.push("reviewerComment required by rubric");
  }

  if (
    annotation.correctedOutputArtifactRef &&
    !dimension.allowCorrectedOutput
  ) {
    errors.push("corrected output not allowed for this dimension");
  }

  return errors;
}

export function validateHumanAnnotationShape(
  value: unknown,
): value is HumanAnnotation {
  if (!value || typeof value !== "object") return false;
  const a = value as HumanAnnotation;
  if (a.annotationSchemaVersion !== ANNOTATION_SCHEMA_VERSION) return false;
  if (typeof a.annotationId !== "string" || !a.annotationId) return false;
  if (typeof a.evaluationSubjectId !== "string" || !a.evaluationSubjectId) {
    return false;
  }
  if (typeof a.rubricId !== "string" || !a.rubricId) return false;
  if (typeof a.rubricVersion !== "string" || !a.rubricVersion) return false;
  if (typeof a.dimensionId !== "string" || !a.dimensionId) return false;
  if (!JUDGMENTS.has(a.judgmentStatus as JudgmentStatus)) return false;
  if (typeof a.reviewerRole !== "string" || !a.reviewerRole) return false;
  if (!isFiniteConfidence(a.confidence)) return false;
  if (!Array.isArray(a.evidenceReviewed)) return false;
  if (typeof a.createdAt !== "string" || !a.createdAt) return false;
  if (!SOURCES.has(a.source)) return false;
  if (!STATUSES.has(a.status)) return false;
  return true;
}

export function assertHumanAnnotation(value: unknown): HumanAnnotation {
  if (!validateHumanAnnotationShape(value)) {
    throw new Error("Invalid human annotation record");
  }
  return value;
}
