import type { EvaluationSubjectPhase, EvaluationSubjectType } from "../subjects/types.js";

export type RubricResponseType =
  | "boolean"
  | "numeric"
  | "categorical"
  | "ordinal"
  | "free_text";

/** Rubric-level channel — required; never silently defaulted. */
export type RubricJudgmentChannel = "human" | "machine";

export interface RubricScoreAnchor {
  value: string | number | boolean;
  label: string;
  definition: string;
}

export interface RubricDimension {
  dimensionId: string;
  name: string;
  description: string;
  responseType: RubricResponseType;
  /** Ordered values for ordinal/categorical scales. */
  allowedValues?: Array<string | number | boolean>;
  numericMin?: number;
  numericMax?: number;
  anchors: RubricScoreAnchor[];
  requiredEvidence: string[];
  optionalEvidence: string[];
  allowCorrectedOutput: boolean;
  reviewerCommentRequired: boolean;
  /** When true, not_applicable judgments count toward rubric completion. */
  notApplicableSatisfiesCompletion?: boolean;
  /** Comment required when judgmentStatus is insufficient_evidence or not_applicable. */
  unscoredCommentRequired?: boolean;
  /**
   * Dimension-level applicability. When omitted, inherits rubric-level
   * applicableSubjectTypes / applicablePhases.
   */
  applicableSubjectTypes?: EvaluationSubjectType[];
  applicablePhases?: EvaluationSubjectPhase[] | null;
}

export interface EvaluationRubric {
  rubricId: string;
  rubricVersion: string;
  name: string;
  description: string;
  /** Required. Missing or invalid values fail rubric validation. */
  judgmentChannel: RubricJudgmentChannel;
  applicableSubjectTypes: EvaluationSubjectType[];
  applicablePhases: EvaluationSubjectPhase[] | null;
  dimensions: RubricDimension[];
  deprecated?: boolean;
  replacedByRubricId?: string | null;
  replacedByRubricVersion?: string | null;
}
