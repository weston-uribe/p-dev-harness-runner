import { mkdir, writeFile } from "node:fs/promises";
import { getEvaluatorSummaryPath } from "../../artifacts/paths.js";
import { deriveEvaluationSessionId } from "../subjects/ids.js";
import { readSubjects } from "../subjects/writer.js";
import { deriveEvaluatorResultStates } from "./effective.js";
import { loadDatasetReadinessPolicy, policyAppliesToSubject } from "./policy.js";
import { ensureEvaluatorsRegistered } from "./register-all.js";
import { getEvaluator, listRegisteredEvaluators } from "./registry.js";
import { readEvaluatorResults } from "./store.js";
import type { EvaluatorSummaryArtifact } from "./types.js";
import { EVALUATOR_ENGINE_VERSION } from "./types.js";

export async function computeEvaluatorSummary(params: {
  evaluationDirectory: string;
  issueKey: string;
  namespace?: string;
  now?: () => string;
}): Promise<EvaluatorSummaryArtifact> {
  await ensureEvaluatorsRegistered();
  const now = params.now ?? (() => new Date().toISOString());
  const namespace =
    params.namespace ?? process.env.P_DEV_EVALUATION_NAMESPACE ?? "default";
  const evaluationSessionId = deriveEvaluationSessionId(
    namespace,
    params.issueKey,
  );
  const { policy, policyHash } = await loadDatasetReadinessPolicy();
  const subjects = await readSubjects(params.evaluationDirectory);
  const results = await readEvaluatorResults(params.evaluationDirectory);
  const states = deriveEvaluatorResultStates(results);
  const effective = states.filter((s) => !s.superseded).map((s) => s.result);

  const effectiveResultsBySubject: Record<string, string[]> = {};
  const resultsByRubricDimension: Record<string, Record<string, string>> = {};
  const totals = { pass: 0, fail: 0, skipped: 0, error: 0 };
  const failingContractChecks: EvaluatorSummaryArtifact["failingContractChecks"] =
    [];
  const missingEvidenceChecks: EvaluatorSummaryArtifact["missingEvidenceChecks"] =
    [];
  const evaluatorVersionDistribution: Record<string, number> = {};

  for (const r of effective) {
    totals[r.status] += 1;
    const list = effectiveResultsBySubject[r.evaluationSubjectId] ?? [];
    list.push(r.evaluatorResultId);
    effectiveResultsBySubject[r.evaluationSubjectId] = list;

    const rubricKey = `${r.rubricId}@${r.rubricVersion}`;
    const dimMap = resultsByRubricDimension[rubricKey] ?? {};
    dimMap[r.dimensionId] = r.status;
    resultsByRubricDimension[rubricKey] = dimMap;

    const verKey = `${r.evaluatorId}@${r.evaluatorVersion}`;
    evaluatorVersionDistribution[verKey] =
      (evaluatorVersionDistribution[verKey] ?? 0) + 1;

    if (r.status === "fail") {
      failingContractChecks.push({
        evaluationSubjectId: r.evaluationSubjectId,
        evaluatorId: r.evaluatorId,
        dimensionId: r.dimensionId,
        reasonCode: r.reasonCode,
      });
    }
    if (
      r.status === "skipped" &&
      r.skipReason === "insufficient_evidence"
    ) {
      missingEvidenceChecks.push({
        evaluationSubjectId: r.evaluationSubjectId,
        evaluatorId: r.evaluatorId,
        dimensionId: r.dimensionId,
      });
    }
  }

  const policyKeys = new Set(
    policy.requiredEvaluators.map(
      (e) => `${e.evaluatorId}@${e.evaluatorVersion}`,
    ),
  );
  const nonCurrentForPolicy: EvaluatorSummaryArtifact["nonCurrentForPolicy"] =
    [];
  for (const r of effective) {
    const key = `${r.evaluatorId}@${r.evaluatorVersion}`;
    if (!policyKeys.has(key)) {
      // Historical result for an evaluator version not in current policy
      const currentDef = getEvaluator(r.evaluatorId, r.evaluatorVersion);
      if (!currentDef) {
        nonCurrentForPolicy.push({
          evaluatorResultId: r.evaluatorResultId,
          evaluationSubjectId: r.evaluationSubjectId,
          evaluatorId: r.evaluatorId,
          evaluatorVersion: r.evaluatorVersion,
        });
      }
    }
    // Also mark if policy requires a different version
    const required = policy.requiredEvaluators.find(
      (e) => e.evaluatorId === r.evaluatorId,
    );
    if (required && required.evaluatorVersion !== r.evaluatorVersion) {
      nonCurrentForPolicy.push({
        evaluatorResultId: r.evaluatorResultId,
        evaluationSubjectId: r.evaluationSubjectId,
        evaluatorId: r.evaluatorId,
        evaluatorVersion: r.evaluatorVersion,
      });
    }
  }

  const registered = listRegisteredEvaluators();
  const subjectsWithNoApplicableEvaluators: string[] = [];
  for (const subject of subjects) {
    const applicable = registered.some((d) => {
      if (!d.applicableSubjectTypes.includes(subject.subjectType)) return false;
      if (d.applicablePhases == null) return true;
      if (subject.phase == null) return false;
      return d.applicablePhases.includes(subject.phase);
    });
    // Also consider policy-required applicability
    const policyApplicable = policy.requiredEvaluators.some((e) =>
      policyAppliesToSubject(e, subject.subjectType, subject.phase),
    );
    if (!applicable && !policyApplicable) {
      subjectsWithNoApplicableEvaluators.push(subject.evaluationSubjectId);
    }
  }

  return {
    schemaVersion: 1,
    engineVersion: EVALUATOR_ENGINE_VERSION,
    evaluationPolicyVersion: policy.policyVersion,
    evaluationPolicyHash: policyHash,
    issueKey: params.issueKey,
    evaluationSessionId,
    computedAt: now(),
    effectiveResultsBySubject,
    resultsByRubricDimension,
    totals,
    failingContractChecks,
    missingEvidenceChecks,
    evaluatorVersionDistribution,
    nonCurrentForPolicy,
    subjectsWithNoApplicableEvaluators,
  };
}

export async function writeEvaluatorSummary(
  evaluationDirectory: string,
  artifact: EvaluatorSummaryArtifact,
): Promise<string> {
  await mkdir(evaluationDirectory, { recursive: true });
  const filePath = getEvaluatorSummaryPath(evaluationDirectory);
  await writeFile(filePath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  return filePath;
}
