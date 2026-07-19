import { mkdtemp, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  appendAnnotation,
  buildAnnotationBundle,
  buildLangfuseAnnotationExport,
  computeAnnotationCoverage,
  computeDatasetReadiness,
  readAnnotations,
} from "../../src/evaluation/annotations/index.js";
import type { EvaluatorResult } from "../../src/evaluation/evaluators/types.js";
import { writeSubjectsIdempotent } from "../../src/evaluation/subjects/writer.js";
import type { EvaluationSubject } from "../../src/evaluation/subjects/types.js";

function planningSubject(id: string): EvaluationSubject {
  return {
    evaluationSubjectSchemaVersion: 1,
    evaluationSubjectId: id,
    subjectType: "phase_execution",
    evaluationSessionId: "c".repeat(64),
    issueKey: "WES-COV",
    harnessRunId: "run-plan",
    phase: "planning",
    phaseExecutionId: "pe-plan",
    revisionCycleIndex: null,
    pmFeedbackCommentId: null,
    agentId: null,
    agentRunId: null,
    toolCallId: null,
    evidenceArtifactRefs: [],
    missingEvidence: ["prompt"],
    evidenceComplete: false,
    telemetryCompletenessSummary: null,
    privacyStatusAtCapture: "metadata_v1",
    createdAt: "2026-07-18T00:00:00.000Z",
    sourceHarnessRelease: null,
    sourceHarnessCommit: null,
    promptContractVersion: "plan-v1",
    modelId: null,
  };
}

describe("coverage, readiness, bundles, langfuse mapping", () => {
  it("computes coverage distinctions and ignores drafts for readiness", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "eval-cov-"));
    const evaluationDirectory = path.join(root, "evaluation");
    await mkdir(evaluationDirectory, { recursive: true });
    const subjectId = "subject-plan-1";
    await writeSubjectsIdempotent(evaluationDirectory, [
      planningSubject(subjectId),
    ]);

    await appendAnnotation({
      evaluationDirectory,
      input: {
        evaluationSubjectId: subjectId,
        rubricId: "planning-quality",
        rubricVersion: "1",
        dimensionId: "problem_understood",
        judgmentStatus: "scored",
        value: 4,
        reviewerRole: "maintainer",
        confidence: 0.8,
        evidenceReviewed: ["agent_output"],
        status: "draft",
      },
      now: () => "2026-07-18T02:00:00.000Z",
    });

    await appendAnnotation({
      evaluationDirectory,
      input: {
        evaluationSubjectId: subjectId,
        rubricId: "planning-quality",
        rubricVersion: "1",
        dimensionId: "problem_understood",
        judgmentStatus: "scored",
        value: 4,
        reviewerRole: "maintainer",
        confidence: 0.9,
        evidenceReviewed: ["agent_output"],
        status: "submitted",
      },
      now: () => "2026-07-18T02:01:00.000Z",
    });

    await appendAnnotation({
      evaluationDirectory,
      input: {
        evaluationSubjectId: subjectId,
        rubricId: "planning-quality",
        rubricVersion: "1",
        dimensionId: "requirements_covered",
        judgmentStatus: "insufficient_evidence",
        reviewerRole: "maintainer",
        confidence: 0.6,
        reviewerComment: "prompt missing",
        evidenceReviewed: [],
        status: "submitted",
      },
      now: () => "2026-07-18T02:02:00.000Z",
    });

    const coverage = await computeAnnotationCoverage({
      evaluationDirectory,
      evaluationSessionId: "c".repeat(64),
      issueKey: "WES-COV",
    });
    expect(coverage.scoredDimensions).toBeGreaterThanOrEqual(1);
    expect(coverage.insufficientEvidenceDimensions).toBeGreaterThanOrEqual(1);
    expect(coverage.missingDimensions).toBeGreaterThan(0);
    expect(coverage.draftAnnotationCount).toBe(1);

    const readiness = await computeDatasetReadiness({
      evaluationDirectory,
      issueKey: "WES-COV",
      namespace: "default",
    });
    const row = readiness.subjects.find(
      (s) => s.evaluationSubjectId === subjectId,
    );
    expect(row?.datasetEligible).toBe(false);
    expect(row?.humanAnnotationComplete).toBe(false);
    expect(row?.datasetIneligibilityReasons.length).toBeGreaterThan(0);

    const bundle = await buildAnnotationBundle({
      evaluationDirectory,
      evaluationSubjectId: subjectId,
    });
    expect(bundle.disposable).toBe(true);
    expect(bundle.annotations.drafts.length).toBe(1);
    expect(
      bundle.rubrics[0]?.fields.some((f) => f.inviteInsufficientEvidence),
    ).toBe(true);

    const annotations = await readAnnotations(evaluationDirectory);
    const exportArtifact = buildLangfuseAnnotationExport({
      issueKey: "WES-COV",
      evaluationSessionId: "c".repeat(64),
      annotations,
      subjectLookup: new Map([
        [
          subjectId,
          {
            subjectType: "phase_execution",
            langfuseSessionId: "c".repeat(64),
            langfuseTraceId: "t".repeat(32),
            langfuseObservationId: null,
          },
        ],
      ]),
    });
    expect(exportArtifact.records.every((r) => r.localAnnotationId)).toBe(true);
    expect(exportArtifact.mappingRules.length).toBe(5);
    expect(exportArtifact.records.every((r) => r.source !== "deterministic_evaluator" as never)).toBe(
      true,
    );

    const evaluatorResult: EvaluatorResult = {
      evaluatorResultSchemaVersion: 1,
      evaluatorResultId: "example-id",
      evaluatorId: "example-det",
      evaluatorVersion: "1",
      evaluatorImplementationHash: "abc",
      evaluationSubjectId: subjectId,
      rubricId: "execution-contract",
      rubricVersion: "1",
      rubricDefinitionHash: "def",
      dimensionId: "phase_completed_successfully",
      result: true,
      status: "pass",
      skipReason: null,
      reasonCode: "phase_completed_successfully",
      evidenceReferences: [],
      missingEvidence: [],
      untrustedEvidence: [],
      explanation: "deterministic placeholder",
      startedAt: "2026-07-18T02:03:00.000Z",
      completedAt: "2026-07-18T02:03:01.000Z",
      executionDurationMs: 1000,
      engineVersion: "evaluator-engine-v1",
      sourceHarnessRelease: null,
      sourceHarnessCommit: null,
      evaluationPolicyVersion: "1",
      evaluationPolicyHash: "pol",
      evidenceFingerprint: "fp",
    };
    expect(evaluatorResult.evaluatorResultSchemaVersion).toBe(1);
    expect(evaluatorResult.skipReason).toBeNull();
  });
});
