import type { ArtifactRef } from "../telemetry/types.js";
import type { EvaluatorOutcome, EvaluatorSkipReason } from "./types.js";

export function passOutcome(
  reasonCode: string,
  explanation: string,
  extras?: Partial<EvaluatorOutcome>,
): EvaluatorOutcome {
  return {
    status: "pass",
    result: true,
    skipReason: null,
    reasonCode,
    explanation,
    ...extras,
  };
}

export function failOutcome(
  reasonCode: string,
  explanation: string,
  extras?: Partial<EvaluatorOutcome>,
): EvaluatorOutcome {
  return {
    status: "fail",
    result: false,
    skipReason: null,
    reasonCode,
    explanation,
    ...extras,
  };
}

export function skippedOutcome(
  skipReason: Exclude<EvaluatorSkipReason, null>,
  reasonCode: string,
  explanation: string,
  extras?: Partial<EvaluatorOutcome>,
): EvaluatorOutcome {
  return {
    status: "skipped",
    result: null,
    skipReason,
    reasonCode,
    explanation,
    ...extras,
  };
}

export function errorOutcome(
  reasonCode: string,
  explanation: string,
  extras?: Partial<EvaluatorOutcome>,
): EvaluatorOutcome {
  return {
    status: "error",
    result: null,
    skipReason: null,
    reasonCode,
    explanation,
    ...extras,
  };
}

export function refsFromEvidence(
  refs: ArtifactRef[] | undefined,
): ArtifactRef[] {
  return refs ?? [];
}
