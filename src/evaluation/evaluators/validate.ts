import type { EvaluatorResult } from "./types.js";
import { EVALUATOR_RESULT_SCHEMA_VERSION } from "./types.js";

const STATUSES = new Set(["pass", "fail", "error", "skipped"]);
const SKIP_REASONS = new Set([
  "not_applicable",
  "insufficient_evidence",
  "dependency_unavailable",
  null,
]);

export function validateEvaluatorResult(result: unknown): {
  ok: boolean;
  errors: string[];
  result?: EvaluatorResult;
} {
  const errors: string[] = [];
  if (!result || typeof result !== "object") {
    return { ok: false, errors: ["result must be an object"] };
  }
  const r = result as EvaluatorResult;
  if (r.evaluatorResultSchemaVersion !== EVALUATOR_RESULT_SCHEMA_VERSION) {
    errors.push("invalid evaluatorResultSchemaVersion");
  }
  if (!r.evaluatorResultId) errors.push("evaluatorResultId required");
  if (!r.evaluationSubjectId) errors.push("evaluationSubjectId required");
  if (!r.evaluatorId) errors.push("evaluatorId required");
  if (!r.evaluatorVersion) errors.push("evaluatorVersion required");
  if (!r.evaluatorImplementationHash)
    errors.push("evaluatorImplementationHash required");
  if (!r.rubricId) errors.push("rubricId required");
  if (!r.rubricVersion) errors.push("rubricVersion required");
  if (!r.rubricDefinitionHash) errors.push("rubricDefinitionHash required");
  if (!r.dimensionId) errors.push("dimensionId required");
  if (!STATUSES.has(r.status)) errors.push("invalid status");
  if (!r.reasonCode) errors.push("reasonCode required");
  if (!r.evidenceFingerprint) errors.push("evidenceFingerprint required");
  if (!SKIP_REASONS.has(r.skipReason)) errors.push("invalid skipReason");

  if (r.status === "pass" || r.status === "fail") {
    if (r.result === null || r.result === undefined) {
      errors.push("pass/fail require result value");
    }
    if (r.skipReason !== null) {
      errors.push("pass/fail require skipReason null");
    }
  }
  if (r.status === "skipped") {
    if (r.skipReason === null) {
      errors.push("skipped requires non-null skipReason");
    }
  }
  if (r.status === "error") {
    if (r.skipReason !== null) {
      errors.push("error requires skipReason null");
    }
  }
  return errors.length === 0
    ? { ok: true, errors: [], result: r }
    : { ok: false, errors };
}

export function assertValidEvaluatorResult(result: unknown): EvaluatorResult {
  const v = validateEvaluatorResult(result);
  if (!v.ok || !v.result) {
    throw new Error(`Invalid evaluator result: ${v.errors.join("; ")}`);
  }
  return v.result;
}
