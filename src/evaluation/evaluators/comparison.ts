import type { HumanAnnotation } from "../annotations/types.js";
import type { EvaluatorResult } from "./types.js";

/**
 * Prepare-only contract for later human ↔ machine analysis.
 * Not operationalized in this slice. Deterministic results are never
 * treated as human ground truth and never overwrite annotations.
 */

export type HumanMachineAgreement =
  | "agree"
  | "disagree"
  | "human_only"
  | "machine_only"
  | "incomparable";

export interface HumanMachineComparisonRecord {
  schemaVersion: 1;
  evaluationSubjectId: string;
  humanAnnotationId: string | null;
  evaluatorResultId: string | null;
  humanRubricId: string | null;
  humanRubricVersion: string | null;
  humanDimensionId: string | null;
  machineRubricId: string | null;
  machineRubricVersion: string | null;
  machineDimensionId: string | null;
  relatedDimension: boolean;
  agreement: HumanMachineAgreement;
  humanJudgmentStatus: HumanAnnotation["judgmentStatus"] | null;
  humanValue: HumanAnnotation["value"] | null;
  machineStatus: EvaluatorResult["status"] | null;
  machineResult: EvaluatorResult["result"] | null;
  machineReasonCode: string | null;
  evidenceReviewed: string[];
  humanAnnotationVersionInfo: {
    rubricId: string;
    rubricVersion: string;
  } | null;
  machineVersionInfo: {
    evaluatorId: string;
    evaluatorVersion: string;
    evaluatorImplementationHash: string;
    rubricDefinitionHash: string;
  } | null;
}

export interface HumanMachineComparisonArtifact {
  schemaVersion: 1;
  computedAt: string;
  issueKey: string;
  evaluationSessionId: string;
  notes: string[];
  records: HumanMachineComparisonRecord[];
}

/** Placeholder builder — returns empty records with contract notes. */
export function buildHumanMachineComparisonStub(params: {
  issueKey: string;
  evaluationSessionId: string;
  now?: () => string;
}): HumanMachineComparisonArtifact {
  const now = params.now ?? (() => new Date().toISOString());
  return {
    schemaVersion: 1,
    computedAt: now(),
    issueKey: params.issueKey,
    evaluationSessionId: params.evaluationSessionId,
    notes: [
      "Comparison format prepared for later analysis.",
      "Deterministic results are not human ground truth.",
      "Do not overwrite annotations with evaluator results.",
    ],
    records: [],
  };
}
