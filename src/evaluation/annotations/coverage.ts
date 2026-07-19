import { mkdir, writeFile } from "node:fs/promises";
import { getAnnotationCoveragePath } from "../../artifacts/paths.js";
import { listRubricsForSubject, loadAllRubrics } from "../rubrics/load.js";
import type { EvaluationSubject } from "../subjects/types.js";
import { readSubjects } from "../subjects/writer.js";
import {
  deriveAnnotationStates,
  getEffectiveSubmittedAnnotation,
} from "./effective.js";
import { readAnnotations } from "./store.js";
import type {
  AnnotationCoverageArtifact,
  DimensionCoverageState,
  SubjectRubricCoverage,
} from "./types.js";
import { ANNOTATION_COVERAGE_SCHEMA_VERSION } from "./types.js";

const PRIMARY_REVIEW_TYPES = new Set([
  "phase_execution",
  "revision_cycle",
  "workflow_session",
]);

function dimensionSatisfiesCompletion(params: {
  state: DimensionCoverageState["state"];
  notApplicableSatisfiesCompletion?: boolean;
}): boolean {
  if (params.state === "scored") return true;
  if (
    params.state === "not_applicable" &&
    params.notApplicableSatisfiesCompletion
  ) {
    return true;
  }
  return false;
}

export async function computeAnnotationCoverage(params: {
  evaluationDirectory: string;
  evaluationSessionId: string;
  issueKey: string;
  now?: () => string;
}): Promise<AnnotationCoverageArtifact> {
  const now = params.now ?? (() => new Date().toISOString());
  const computedAt = now();
  const subjects = await readSubjects(params.evaluationDirectory);
  const annotations = await readAnnotations(params.evaluationDirectory);
  const states = deriveAnnotationStates(annotations);

  const subjectsByType: Record<string, number> = {};
  const subjectsByPhase: Record<string, number> = {};
  for (const subject of subjects) {
    subjectsByType[subject.subjectType] =
      (subjectsByType[subject.subjectType] ?? 0) + 1;
    const phaseKey = subject.phase ?? "null";
    subjectsByPhase[phaseKey] = (subjectsByPhase[phaseKey] ?? 0) + 1;
  }

  const eligibleSubjects = subjects.filter((s) =>
    PRIMARY_REVIEW_TYPES.has(s.subjectType),
  );

  const subjectRubrics: SubjectRubricCoverage[] = [];
  let completeRubricCoverage = 0;
  let partialRubricCoverage = 0;
  let missingRequiredDimensions = 0;
  let scoredDimensions = 0;
  let insufficientEvidenceDimensions = 0;
  let notApplicableDimensions = 0;
  let missingDimensions = 0;
  const coverageByRubricVersion: AnnotationCoverageArtifact["coverageByRubricVersion"] =
    {};
  const annotatedSubjectIds = new Set<string>();

  for (const subject of eligibleSubjects) {
    const rubrics = await listRubricsForSubject({
      subjectType: subject.subjectType,
      phase: subject.phase,
      judgmentChannel: "human",
    });
    for (const rubric of rubrics) {
      const dimensions: DimensionCoverageState[] = [];
      for (const dimension of rubric.dimensions) {
        const effective = getEffectiveSubmittedAnnotation(annotations, {
          evaluationSubjectId: subject.evaluationSubjectId,
          rubricId: rubric.rubricId,
          rubricVersion: rubric.rubricVersion,
          dimensionId: dimension.dimensionId,
        });
        let state: DimensionCoverageState["state"] = "missing";
        if (effective) {
          annotatedSubjectIds.add(subject.evaluationSubjectId);
          if (effective.judgmentStatus === "scored") state = "scored";
          else if (effective.judgmentStatus === "insufficient_evidence") {
            state = "insufficient_evidence";
          } else state = "not_applicable";
        }
        const satisfiesCompletion = dimensionSatisfiesCompletion({
          state,
          notApplicableSatisfiesCompletion:
            dimension.notApplicableSatisfiesCompletion,
        });
        dimensions.push({
          dimensionId: dimension.dimensionId,
          state,
          annotationId: effective?.annotationId,
          satisfiesCompletion,
        });
        if (state === "scored") scoredDimensions += 1;
        else if (state === "insufficient_evidence") {
          insufficientEvidenceDimensions += 1;
        } else if (state === "not_applicable") {
          notApplicableDimensions += 1;
        } else {
          missingDimensions += 1;
          missingRequiredDimensions += 1;
        }
      }

      const complete = dimensions.every((d) => d.satisfiesCompletion);
      const anyAnswered = dimensions.some((d) => d.state !== "missing");
      const partial = !complete && anyAnswered;
      if (complete) completeRubricCoverage += 1;
      if (partial) partialRubricCoverage += 1;

      const versionKey = `${rubric.rubricId}@${rubric.rubricVersion}`;
      const bucket = coverageByRubricVersion[versionKey] ?? {
        complete: 0,
        partial: 0,
        missing: 0,
      };
      if (complete) bucket.complete += 1;
      else if (partial) bucket.partial += 1;
      else bucket.missing += 1;
      coverageByRubricVersion[versionKey] = bucket;

      subjectRubrics.push({
        evaluationSubjectId: subject.evaluationSubjectId,
        subjectType: subject.subjectType,
        phase: subject.phase,
        rubricId: rubric.rubricId,
        rubricVersion: rubric.rubricVersion,
        dimensions,
        complete,
        partial,
      });
    }
  }

  let supersededAnnotationCount = 0;
  let invalidatedAnnotationCount = 0;
  let draftAnnotationCount = 0;
  for (const state of states.values()) {
    if (state.superseded) supersededAnnotationCount += 1;
    if (state.invalidated) invalidatedAnnotationCount += 1;
    if (state.annotation.status === "draft") draftAnnotationCount += 1;
  }

  // Ensure all known human rubrics appear in version map even with zero subjects.
  for (const rubric of await loadAllRubrics()) {
    if (rubric.judgmentChannel !== "human") continue;
    const versionKey = `${rubric.rubricId}@${rubric.rubricVersion}`;
    coverageByRubricVersion[versionKey] ??= {
      complete: 0,
      partial: 0,
      missing: 0,
    };
  }

  return {
    schemaVersion: ANNOTATION_COVERAGE_SCHEMA_VERSION,
    evaluationSessionId: params.evaluationSessionId,
    issueKey: params.issueKey,
    computedAt,
    subjectsByType,
    subjectsByPhase,
    eligibleSubjects: eligibleSubjects.length,
    annotatedSubjects: annotatedSubjectIds.size,
    completeRubricCoverage,
    partialRubricCoverage,
    missingRequiredDimensions,
    scoredDimensions,
    insufficientEvidenceDimensions,
    notApplicableDimensions,
    missingDimensions,
    supersededAnnotationCount,
    invalidatedAnnotationCount,
    draftAnnotationCount,
    coverageByRubricVersion,
    subjectRubrics,
  };
}

export async function writeAnnotationCoverage(
  evaluationDirectory: string,
  artifact: AnnotationCoverageArtifact,
): Promise<string> {
  await mkdir(evaluationDirectory, { recursive: true });
  const filePath = getAnnotationCoveragePath(evaluationDirectory);
  await writeFile(filePath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  return filePath;
}

export function isPrimaryReviewSubject(subject: EvaluationSubject): boolean {
  return PRIMARY_REVIEW_TYPES.has(subject.subjectType);
}
