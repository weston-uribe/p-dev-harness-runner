import { mkdir, writeFile } from "node:fs/promises";
import { getDatasetReadinessPath } from "../../artifacts/paths.js";
import { deriveEvaluatorResultStates } from "../evaluators/effective.js";
import {
  loadDatasetReadinessPolicy,
  policyAppliesToSubject,
} from "../evaluators/policy.js";
import { ensureEvaluatorsRegistered } from "../evaluators/register-all.js";
import { readEvaluatorResults } from "../evaluators/store.js";
import type { EvaluatorResult } from "../evaluators/types.js";
import { listRubricsForSubject } from "../rubrics/load.js";
import { deriveEvaluationSessionId } from "../subjects/ids.js";
import { readSubjects } from "../subjects/writer.js";
import { getEffectiveSubmittedAnnotation } from "./effective.js";
import { isPrimaryReviewSubject } from "./coverage.js";
import { readAnnotations } from "./store.js";
import type {
  DatasetReadinessArtifact,
  DatasetReadinessRecord,
  DeterministicEvaluatorReadinessEntry,
  DeterministicEvaluatorReadinessState,
  PrivacyReviewStatus,
} from "./types.js";
import { DATASET_READINESS_POLICY_VERSION } from "./types.js";

function dimensionComplete(params: {
  judgmentStatus: string | undefined;
  notApplicableSatisfiesCompletion?: boolean;
}): boolean {
  if (params.judgmentStatus === "scored") return true;
  if (
    params.judgmentStatus === "not_applicable" &&
    params.notApplicableSatisfiesCompletion
  ) {
    return true;
  }
  return false;
}

function classifyEvaluatorResult(
  result: EvaluatorResult | null,
  hasNonCurrent: boolean,
): DeterministicEvaluatorReadinessState {
  if (hasNonCurrent && !result) return "non_current_for_policy";
  if (!result) return "no_current_policy_result";
  if (result.status === "pass") return "passed";
  if (result.status === "fail") return "failed";
  if (result.status === "error") return "error";
  if (result.status === "skipped") {
    if (result.skipReason === "not_applicable") return "skipped_not_applicable";
    if (result.skipReason === "insufficient_evidence") {
      return "skipped_insufficient_evidence";
    }
    if (result.skipReason === "dependency_unavailable") {
      return "skipped_dependency_unavailable";
    }
  }
  return "no_current_policy_result";
}

function stateSatisfiesPolicy(
  state: DeterministicEvaluatorReadinessState,
  policy: {
    notApplicableSatisfiesCompletion: boolean;
    insufficientEvidenceBlocksReadiness: boolean;
    dependencyUnavailableBlocksReadiness: boolean;
    evaluatorErrorBlocksReadiness: boolean;
    failureBlocksEligibility: boolean;
  },
): { complete: boolean; reason: string | null } {
  switch (state) {
    case "passed":
      return { complete: true, reason: null };
    case "skipped_not_applicable":
      return {
        complete: policy.notApplicableSatisfiesCompletion,
        reason: policy.notApplicableSatisfiesCompletion
          ? null
          : "deterministic_skipped_not_applicable",
      };
    case "failed":
      return {
        complete: false,
        reason: policy.failureBlocksEligibility
          ? "deterministic_contract_failure"
          : null,
      };
    case "skipped_insufficient_evidence":
      return {
        complete: !policy.insufficientEvidenceBlocksReadiness,
        reason: policy.insufficientEvidenceBlocksReadiness
          ? "deterministic_insufficient_evidence"
          : null,
      };
    case "skipped_dependency_unavailable":
      return {
        complete: !policy.dependencyUnavailableBlocksReadiness,
        reason: policy.dependencyUnavailableBlocksReadiness
          ? "deterministic_dependency_unavailable"
          : null,
      };
    case "error":
      return {
        complete: false,
        reason: policy.evaluatorErrorBlocksReadiness
          ? "deterministic_evaluator_error"
          : null,
      };
    case "no_current_policy_result":
      return { complete: false, reason: "deterministic_evaluators_incomplete" };
    case "non_current_for_policy":
      return {
        complete: false,
        reason: "deterministic_non_current_for_policy",
      };
    default:
      return { complete: false, reason: "deterministic_evaluators_incomplete" };
  }
}

export async function computeDatasetReadiness(params: {
  evaluationDirectory: string;
  issueKey: string;
  namespace?: string;
  privacyReviewBySubjectId?: Record<string, PrivacyReviewStatus>;
  now?: () => string;
}): Promise<DatasetReadinessArtifact> {
  const now = params.now ?? (() => new Date().toISOString());
  const computedAt = now();
  const namespace =
    params.namespace ?? process.env.P_DEV_EVALUATION_NAMESPACE ?? "default";
  const evaluationSessionId = deriveEvaluationSessionId(
    namespace,
    params.issueKey,
  );
  const subjects = await readSubjects(params.evaluationDirectory);
  const annotations = await readAnnotations(params.evaluationDirectory);

  await ensureEvaluatorsRegistered();
  const { policy, policyHash } = await loadDatasetReadinessPolicy();
  const evaluatorResults = await readEvaluatorResults(
    params.evaluationDirectory,
  );
  const effectiveResults = deriveEvaluatorResultStates(evaluatorResults)
    .filter((s) => !s.superseded)
    .map((s) => s.result);

  const records: DatasetReadinessRecord[] = [];
  for (const subject of subjects) {
    const reasons: string[] = [];
    const evidenceComplete = subject.evidenceComplete;
    if (!evidenceComplete) reasons.push("evidence_incomplete");

    const privacyReviewStatus =
      params.privacyReviewBySubjectId?.[subject.evaluationSubjectId] ??
      "not_reviewed";
    if (privacyReviewStatus !== "approved") {
      reasons.push(`privacy_${privacyReviewStatus}`);
    }

    let humanAnnotationComplete = false;
    let requiredRubricsComplete = false;
    let hasPreferredOutput = false;

    if (isPrimaryReviewSubject(subject)) {
      const rubrics = await listRubricsForSubject({
        subjectType: subject.subjectType,
        phase: subject.phase,
        judgmentChannel: "human",
      });
      if (rubrics.length === 0) {
        reasons.push("no_applicable_rubrics");
      } else {
        let allRubricsComplete = true;
        let allDimensionsAnnotated = true;
        for (const rubric of rubrics) {
          let rubricComplete = true;
          for (const dimension of rubric.dimensions) {
            const effective = getEffectiveSubmittedAnnotation(annotations, {
              evaluationSubjectId: subject.evaluationSubjectId,
              rubricId: rubric.rubricId,
              rubricVersion: rubric.rubricVersion,
              dimensionId: dimension.dimensionId,
            });
            if (!effective) {
              allDimensionsAnnotated = false;
              rubricComplete = false;
              continue;
            }
            if (effective.correctedOutputArtifactRef) {
              hasPreferredOutput = true;
            }
            if (
              !dimensionComplete({
                judgmentStatus: effective.judgmentStatus,
                notApplicableSatisfiesCompletion:
                  dimension.notApplicableSatisfiesCompletion,
              })
            ) {
              rubricComplete = false;
            }
          }
          if (!rubricComplete) allRubricsComplete = false;
        }
        humanAnnotationComplete = allDimensionsAnnotated;
        requiredRubricsComplete = allRubricsComplete;
        if (!humanAnnotationComplete) {
          reasons.push("human_annotation_incomplete");
        }
        if (!requiredRubricsComplete) {
          reasons.push("required_rubrics_incomplete");
        }
      }
    } else {
      reasons.push("subject_type_not_dataset_primary");
    }

    const requiredForSubject = policy.requiredEvaluators.filter((entry) =>
      policyAppliesToSubject(entry, subject.subjectType, subject.phase),
    );

    const deterministicEvaluatorStates: DeterministicEvaluatorReadinessEntry[] =
      [];
    let deterministicEvaluatorsComplete = true;
    let deterministicEvaluatorErrors = false;
    let unresolvedContractFailures = false;

    for (const entry of requiredForSubject) {
      const current = effectiveResults
        .filter(
          (r) =>
            r.evaluationSubjectId === subject.evaluationSubjectId &&
            r.evaluatorId === entry.evaluatorId &&
            r.evaluatorVersion === entry.evaluatorVersion,
        )
        .sort((a, b) => a.completedAt.localeCompare(b.completedAt));
      const currentResult = current[current.length - 1] ?? null;

      const historicalOtherVersion = effectiveResults.some(
        (r) =>
          r.evaluationSubjectId === subject.evaluationSubjectId &&
          r.evaluatorId === entry.evaluatorId &&
          r.evaluatorVersion !== entry.evaluatorVersion,
      );

      const state = classifyEvaluatorResult(
        currentResult,
        Boolean(historicalOtherVersion && !currentResult),
      );
      deterministicEvaluatorStates.push({
        evaluatorId: entry.evaluatorId,
        evaluatorVersion: entry.evaluatorVersion,
        state,
        evaluatorResultId: currentResult?.evaluatorResultId ?? null,
        reasonCode: currentResult?.reasonCode ?? null,
      });

      const sat = stateSatisfiesPolicy(state, policy);
      if (!sat.complete) {
        deterministicEvaluatorsComplete = false;
        if (sat.reason) {
          if (sat.reason === "deterministic_contract_failure") {
            unresolvedContractFailures = true;
            reasons.push(
              `deterministic_contract_failure:${entry.evaluatorId}:${currentResult?.dimensionId ?? "unknown"}`,
            );
          } else {
            reasons.push(`${sat.reason}:${entry.evaluatorId}`);
          }
        }
      }
      if (state === "error") deterministicEvaluatorErrors = true;
      if (state === "failed") unresolvedContractFailures = true;
    }

    if (requiredForSubject.length === 0) {
      // No machine checks required for this subject type under policy.
      deterministicEvaluatorsComplete = true;
    }

    const datasetEligible =
      evidenceComplete &&
      humanAnnotationComplete &&
      requiredRubricsComplete &&
      privacyReviewStatus === "approved" &&
      isPrimaryReviewSubject(subject) &&
      deterministicEvaluatorsComplete &&
      !deterministicEvaluatorErrors &&
      !unresolvedContractFailures;

    if (!datasetEligible && reasons.length === 0) {
      reasons.push("dataset_eligible_default_false");
    }

    records.push({
      evaluationSubjectId: subject.evaluationSubjectId,
      evidenceComplete,
      humanAnnotationComplete,
      requiredRubricsComplete,
      hasPreferredOutput,
      privacyReviewStatus,
      deterministicEvaluatorsComplete,
      deterministicEvaluatorErrors,
      unresolvedContractFailures,
      deterministicEvaluatorStates,
      datasetEligible,
      datasetIneligibilityReasons: datasetEligible ? [] : reasons,
      computedAt,
      readinessPolicyVersion: DATASET_READINESS_POLICY_VERSION,
      evaluationPolicyVersion: policy.policyVersion,
      evaluationPolicyHash: policyHash,
    });
  }

  return {
    schemaVersion: 1,
    readinessPolicyVersion: DATASET_READINESS_POLICY_VERSION,
    evaluationPolicyVersion: policy.policyVersion,
    evaluationPolicyHash: policyHash,
    evaluationSessionId,
    issueKey: params.issueKey,
    computedAt,
    subjects: records,
  };
}

export async function writeDatasetReadiness(
  evaluationDirectory: string,
  artifact: DatasetReadinessArtifact,
): Promise<string> {
  await mkdir(evaluationDirectory, { recursive: true });
  const filePath = getDatasetReadinessPath(evaluationDirectory);
  await writeFile(filePath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  return filePath;
}
