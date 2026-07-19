import { exactLineageKey } from "./ids.js";
import type { EvaluatorResult } from "./types.js";

export interface EvaluatorResultState {
  result: EvaluatorResult;
  superseded: boolean;
}

export function deriveEvaluatorResultStates(
  results: EvaluatorResult[],
): EvaluatorResultState[] {
  const byId = new Map(results.map((r) => [r.evaluatorResultId, r]));
  const supersededIds = new Set<string>();
  for (const r of results) {
    if (r.supersedesEvaluatorResultId) {
      supersededIds.add(r.supersedesEvaluatorResultId);
    }
  }
  // Also walk chains
  let changed = true;
  while (changed) {
    changed = false;
    for (const id of [...supersededIds]) {
      const node = byId.get(id);
      if (node?.supersedesEvaluatorResultId) {
        if (!supersededIds.has(node.supersedesEvaluatorResultId)) {
          supersededIds.add(node.supersedesEvaluatorResultId);
          changed = true;
        }
      }
    }
  }
  return results.map((result) => ({
    result,
    superseded: supersededIds.has(result.evaluatorResultId),
  }));
}

/** Exact-lineage effective result (latest non-superseded in lineage). */
export function getExactLineageEffectiveResult(
  results: EvaluatorResult[],
  key: {
    evaluationSubjectId: string;
    evaluatorId: string;
    evaluatorVersion: string;
    evaluatorImplementationHash: string;
    rubricId: string;
    rubricVersion: string;
    rubricDefinitionHash: string;
    dimensionId: string;
  },
): EvaluatorResult | null {
  const lineage = exactLineageKey(key);
  const states = deriveEvaluatorResultStates(results);
  const matches = states
    .filter((s) => !s.superseded)
    .filter(
      (s) =>
        exactLineageKey({
          evaluationSubjectId: s.result.evaluationSubjectId,
          evaluatorId: s.result.evaluatorId,
          evaluatorVersion: s.result.evaluatorVersion,
          evaluatorImplementationHash: s.result.evaluatorImplementationHash,
          rubricId: s.result.rubricId,
          rubricVersion: s.result.rubricVersion,
          rubricDefinitionHash: s.result.rubricDefinitionHash,
          dimensionId: s.result.dimensionId,
        }) === lineage,
    )
    .map((s) => s.result)
    .sort((a, b) => a.completedAt.localeCompare(b.completedAt));
  return matches.length > 0 ? matches[matches.length - 1]! : null;
}

export function getResultById(
  results: EvaluatorResult[],
  evaluatorResultId: string,
): EvaluatorResult | null {
  return results.find((r) => r.evaluatorResultId === evaluatorResultId) ?? null;
}
