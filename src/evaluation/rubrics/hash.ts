import { createHash } from "node:crypto";
import type { EvaluationRubric } from "./types.js";

/**
 * Canonical JSON for hashing: stable key order via JSON.stringify of a
 * normalized object tree (insertion order of validated rubric fields).
 */
export function canonicalizeRubricForHash(rubric: EvaluationRubric): string {
  return `${JSON.stringify(rubric)}\n`;
}

export function computeRubricDefinitionHash(rubric: EvaluationRubric): string {
  return createHash("sha256")
    .update(canonicalizeRubricForHash(rubric), "utf8")
    .digest("hex");
}
