import { mkdtemp, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  appendAnnotation,
  getEffectiveSubmittedAnnotation,
  getLatestDraftAnnotation,
  readAnnotations,
} from "../../src/evaluation/annotations/index.js";
import { writeSubjectsIdempotent } from "../../src/evaluation/subjects/writer.js";
import type { EvaluationSubject } from "../../src/evaluation/subjects/types.js";

function subject(id: string): EvaluationSubject {
  return {
    evaluationSubjectSchemaVersion: 1,
    evaluationSubjectId: id,
    subjectType: "phase_execution",
    evaluationSessionId: "s".repeat(64),
    issueKey: "WES-ANN",
    harnessRunId: "run-1",
    phase: "implementation",
    phaseExecutionId: "pe",
    revisionCycleIndex: null,
    pmFeedbackCommentId: null,
    agentId: null,
    agentRunId: null,
    toolCallId: null,
    evidenceArtifactRefs: [],
    missingEvidence: [],
    evidenceComplete: true,
    telemetryCompletenessSummary: null,
    privacyStatusAtCapture: "local_only",
    createdAt: "2026-07-18T00:00:00.000Z",
    sourceHarnessRelease: null,
    sourceHarnessCommit: null,
    promptContractVersion: "v1",
    modelId: "composer-2.5",
  };
}

describe("annotation store", () => {
  it("appends, idempotently retries, supersedes, and resolves effective/draft", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "eval-ann-"));
    const evaluationDirectory = path.join(root, "evaluation");
    await mkdir(evaluationDirectory, { recursive: true });
    await writeSubjectsIdempotent(evaluationDirectory, [
      subject("subject-impl-1"),
    ]);

    const draft = await appendAnnotation({
      evaluationDirectory,
      input: {
        evaluationSubjectId: "subject-impl-1",
        rubricId: "implementation-quality",
        rubricVersion: "1",
        dimensionId: "task_completed",
        judgmentStatus: "scored",
        value: 3,
        reviewerRole: "maintainer",
        confidence: 0.7,
        evidenceReviewed: ["agent_output"],
        status: "draft",
        clientRequestId: "req-draft-1",
      },
      now: () => "2026-07-18T01:00:00.000Z",
    });
    expect(draft.reusedExisting).toBe(false);

    const draftRetry = await appendAnnotation({
      evaluationDirectory,
      input: {
        evaluationSubjectId: "subject-impl-1",
        rubricId: "implementation-quality",
        rubricVersion: "1",
        dimensionId: "task_completed",
        judgmentStatus: "scored",
        value: 4,
        reviewerRole: "maintainer",
        confidence: 0.8,
        evidenceReviewed: ["agent_output"],
        status: "draft",
        clientRequestId: "req-draft-1",
      },
      now: () => "2026-07-18T01:01:00.000Z",
    });
    expect(draftRetry.reusedExisting).toBe(true);
    expect(draftRetry.annotation.annotationId).toBe(draft.annotation.annotationId);

    const submitted = await appendAnnotation({
      evaluationDirectory,
      input: {
        evaluationSubjectId: "subject-impl-1",
        rubricId: "implementation-quality",
        rubricVersion: "1",
        dimensionId: "task_completed",
        judgmentStatus: "scored",
        value: 4,
        reviewerRole: "maintainer",
        confidence: 0.9,
        evidenceReviewed: ["agent_output"],
        status: "submitted",
        clientRequestId: "req-sub-1",
      },
      now: () => "2026-07-18T01:02:00.000Z",
    });

    const replacement = await appendAnnotation({
      evaluationDirectory,
      input: {
        evaluationSubjectId: "subject-impl-1",
        rubricId: "implementation-quality",
        rubricVersion: "1",
        dimensionId: "task_completed",
        judgmentStatus: "scored",
        value: 5,
        reviewerRole: "maintainer",
        confidence: 1,
        evidenceReviewed: ["agent_output"],
        status: "submitted",
        supersedesAnnotationId: submitted.annotation.annotationId,
        clientRequestId: "req-sub-2",
        correctedOutput: "preferred final report",
      },
      now: () => "2026-07-18T01:03:00.000Z",
    });
    expect(replacement.annotation.correctedOutputArtifactRef?.artifactPath).toMatch(
      /corrected-outputs\//,
    );

    const all = await readAnnotations(evaluationDirectory);
    expect(all).toHaveLength(3);

    const effective = getEffectiveSubmittedAnnotation(all, {
      evaluationSubjectId: "subject-impl-1",
      rubricId: "implementation-quality",
      rubricVersion: "1",
      dimensionId: "task_completed",
    });
    expect(effective?.annotationId).toBe(replacement.annotation.annotationId);
    expect(effective?.value).toBe(5);

    const latestDraft = getLatestDraftAnnotation(all, {
      evaluationSubjectId: "subject-impl-1",
      rubricId: "implementation-quality",
      rubricVersion: "1",
      dimensionId: "task_completed",
    });
    expect(latestDraft?.annotationId).toBe(draft.annotation.annotationId);
  });

  it("enforces judgmentStatus value rules and confidence bounds", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "eval-ann2-"));
    const evaluationDirectory = path.join(root, "evaluation");
    await writeSubjectsIdempotent(evaluationDirectory, [
      subject("subject-impl-2"),
    ]);

    await expect(
      appendAnnotation({
        evaluationDirectory,
        input: {
          evaluationSubjectId: "subject-impl-2",
          rubricId: "implementation-quality",
          rubricVersion: "1",
          dimensionId: "task_completed",
          judgmentStatus: "insufficient_evidence",
          value: 1,
          reviewerRole: "maintainer",
          confidence: 0.5,
          reviewerComment: "missing prompt",
          evidenceReviewed: [],
          status: "submitted",
        },
      }),
    ).rejects.toThrow(/value prohibited/);

    await expect(
      appendAnnotation({
        evaluationDirectory,
        input: {
          evaluationSubjectId: "subject-impl-2",
          rubricId: "implementation-quality",
          rubricVersion: "1",
          dimensionId: "task_completed",
          judgmentStatus: "scored",
          value: 2,
          reviewerRole: "maintainer",
          confidence: 1.5,
          evidenceReviewed: ["agent_output"],
          status: "submitted",
        },
      }),
    ).rejects.toThrow(/confidence/);

    const ok = await appendAnnotation({
      evaluationDirectory,
      input: {
        evaluationSubjectId: "subject-impl-2",
        rubricId: "implementation-quality",
        rubricVersion: "1",
        dimensionId: "task_completed",
        judgmentStatus: "insufficient_evidence",
        reviewerRole: "maintainer",
        confidence: 0.4,
        reviewerComment: "required evidence missing",
        evidenceReviewed: [],
        status: "submitted",
      },
    });
    expect(ok.annotation.judgmentStatus).toBe("insufficient_evidence");
    expect(ok.annotation.value).toBeUndefined();
  });

  it("rejects non-human sources", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "eval-ann3-"));
    const evaluationDirectory = path.join(root, "evaluation");
    await writeSubjectsIdempotent(evaluationDirectory, [
      subject("subject-impl-3"),
    ]);
    await expect(
      appendAnnotation({
        evaluationDirectory,
        input: {
          evaluationSubjectId: "subject-impl-3",
          rubricId: "implementation-quality",
          rubricVersion: "1",
          dimensionId: "task_completed",
          judgmentStatus: "scored",
          value: 3,
          reviewerRole: "bot",
          confidence: 0.5,
          evidenceReviewed: [],
          status: "submitted",
          source: "deterministic_evaluator" as never,
        },
      }),
    ).rejects.toThrow(/Only human_local and human_langfuse/);
  });
});
