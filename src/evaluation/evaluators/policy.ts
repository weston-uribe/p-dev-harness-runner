import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { EvaluationSubjectPhase, EvaluationSubjectType } from "../subjects/types.js";

export interface RequiredEvaluatorPolicyEntry {
  evaluatorId: string;
  evaluatorVersion: string;
  applicableSubjectTypes: EvaluationSubjectType[];
  applicablePhases: EvaluationSubjectPhase[] | null;
}

export interface DatasetReadinessEvaluatorPolicy {
  policyId: string;
  policyVersion: string;
  description: string;
  notApplicableSatisfiesCompletion: boolean;
  insufficientEvidenceBlocksReadiness: boolean;
  dependencyUnavailableBlocksReadiness: boolean;
  evaluatorErrorBlocksReadiness: boolean;
  failureBlocksEligibility: boolean;
  requiredEvaluators: RequiredEvaluatorPolicyEntry[];
}

export interface LoadedEvaluatorPolicy {
  policy: DatasetReadinessEvaluatorPolicy;
  policyHash: string;
  raw: string;
}

function policyPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.join(here, "policies", "dataset-readiness.v1.json");
}

export function getDatasetReadinessPolicyPath(): string {
  return policyPath();
}

export async function loadDatasetReadinessPolicy(
  filePath = policyPath(),
): Promise<LoadedEvaluatorPolicy> {
  const raw = await readFile(filePath, "utf8");
  const policy = JSON.parse(raw) as DatasetReadinessEvaluatorPolicy;
  if (!policy.policyVersion || !Array.isArray(policy.requiredEvaluators)) {
    throw new Error(`Invalid evaluator readiness policy at ${filePath}`);
  }
  const policyHash = createHash("sha256").update(raw, "utf8").digest("hex");
  return { policy, policyHash, raw };
}

export function policyAppliesToSubject(
  entry: RequiredEvaluatorPolicyEntry,
  subjectType: string,
  phase: string | null,
): boolean {
  if (!entry.applicableSubjectTypes.includes(subjectType as never)) {
    return false;
  }
  if (entry.applicablePhases == null) return true;
  if (phase == null) return false;
  return entry.applicablePhases.includes(phase as never);
}
