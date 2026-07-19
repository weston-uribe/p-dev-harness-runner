import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { getAnnotationBundlesDirectory } from "../../artifacts/paths.js";
import { boundString } from "../telemetry/bounds.js";
import { redactSecrets } from "../../artifacts/redact.js";
import { listRubricsForSubject } from "../rubrics/load.js";
import type { EvaluationRubric } from "../rubrics/types.js";
import type { EvaluationSubject } from "../subjects/types.js";
import { readSubjects } from "../subjects/writer.js";
import {
  getEffectiveSubmittedAnnotation,
  getLatestDraftAnnotation,
} from "./effective.js";
import { readAnnotations } from "./store.js";
import type { HumanAnnotation } from "./types.js";

const PREVIEW_CHARS = 1_200;

export interface AnnotationBundleField {
  dimensionId: string;
  name: string;
  description: string;
  responseType: string;
  anchors: EvaluationRubric["dimensions"][number]["anchors"];
  requiredEvidence: string[];
  optionalEvidence: string[];
  allowCorrectedOutput: boolean;
  reviewerCommentRequired: boolean;
  unscoredCommentRequired?: boolean;
  notApplicableSatisfiesCompletion?: boolean;
  inviteInsufficientEvidence: boolean;
  effectiveSubmitted: HumanAnnotation | null;
  latestDraft: HumanAnnotation | null;
}

export interface AnnotationBundle {
  schemaVersion: 1;
  disposable: true;
  generatedAt: string;
  scope: "phase" | "revision_cycle" | "workflow_session";
  subject: EvaluationSubject;
  rubrics: Array<{
    rubricId: string;
    rubricVersion: string;
    name: string;
    description: string;
    fields: AnnotationBundleField[];
  }>;
  evidenceReferences: EvaluationSubject["evidenceArtifactRefs"];
  evidencePreviews?: Array<{
    artifactPath: string;
    preview: string;
  }>;
  telemetryCompleteness: EvaluationSubject["telemetryCompletenessSummary"];
  missingRequiredEvidence: string[];
  annotations: {
    effectiveSubmitted: HumanAnnotation[];
    drafts: HumanAnnotation[];
  };
}

async function loadPreviews(
  runDirectory: string | null,
  subject: EvaluationSubject,
): Promise<AnnotationBundle["evidencePreviews"]> {
  if (!runDirectory) return undefined;
  const previews: NonNullable<AnnotationBundle["evidencePreviews"]> = [];
  for (const ref of subject.evidenceArtifactRefs) {
    try {
      const absolute = path.join(runDirectory, ref.artifactPath);
      const raw = await readFile(absolute, "utf8");
      const preview = boundString(redactSecrets(raw), PREVIEW_CHARS);
      if (preview) {
        previews.push({ artifactPath: ref.artifactPath, preview });
      }
    } catch {
      // skip missing preview sources
    }
  }
  return previews;
}

export async function buildAnnotationBundle(params: {
  evaluationDirectory: string;
  evaluationSubjectId: string;
  includePreviews?: boolean;
  /** Run directory used only for optional evidence previews. */
  runDirectory?: string;
  now?: () => string;
}): Promise<AnnotationBundle> {
  const now = params.now ?? (() => new Date().toISOString());
  const subjects = await readSubjects(params.evaluationDirectory);
  const subject = subjects.find(
    (s) => s.evaluationSubjectId === params.evaluationSubjectId,
  );
  if (!subject) {
    throw new Error(`Unknown subject: ${params.evaluationSubjectId}`);
  }

  let scope: AnnotationBundle["scope"];
  if (subject.subjectType === "workflow_session") scope = "workflow_session";
  else if (subject.subjectType === "revision_cycle") scope = "revision_cycle";
  else if (subject.subjectType === "phase_execution") scope = "phase";
  else {
    throw new Error(
      `Bundles are not supported for subjectType ${subject.subjectType} in v1`,
    );
  }

  const annotations = await readAnnotations(params.evaluationDirectory);
  const rubrics = await listRubricsForSubject({
    subjectType: subject.subjectType,
    phase: subject.phase,
    judgmentChannel: "human",
  });

  const effectiveSubmitted: HumanAnnotation[] = [];
  const drafts: HumanAnnotation[] = [];
  const rubricBlocks: AnnotationBundle["rubrics"] = [];

  for (const rubric of rubrics) {
    const fields: AnnotationBundleField[] = [];
    for (const dimension of rubric.dimensions) {
      const submitted = getEffectiveSubmittedAnnotation(annotations, {
        evaluationSubjectId: subject.evaluationSubjectId,
        rubricId: rubric.rubricId,
        rubricVersion: rubric.rubricVersion,
        dimensionId: dimension.dimensionId,
      });
      const draft = getLatestDraftAnnotation(annotations, {
        evaluationSubjectId: subject.evaluationSubjectId,
        rubricId: rubric.rubricId,
        rubricVersion: rubric.rubricVersion,
        dimensionId: dimension.dimensionId,
      });
      if (submitted) effectiveSubmitted.push(submitted);
      if (draft) drafts.push(draft);

      const missingRequired = dimension.requiredEvidence.filter((key) =>
        subject.missingEvidence.includes(key),
      );
      fields.push({
        dimensionId: dimension.dimensionId,
        name: dimension.name,
        description: dimension.description,
        responseType: dimension.responseType,
        anchors: dimension.anchors,
        requiredEvidence: dimension.requiredEvidence,
        optionalEvidence: dimension.optionalEvidence,
        allowCorrectedOutput: dimension.allowCorrectedOutput,
        reviewerCommentRequired: dimension.reviewerCommentRequired,
        unscoredCommentRequired: dimension.unscoredCommentRequired,
        notApplicableSatisfiesCompletion:
          dimension.notApplicableSatisfiesCompletion,
        inviteInsufficientEvidence: missingRequired.length > 0,
        effectiveSubmitted: submitted,
        latestDraft: draft,
      });
    }
    rubricBlocks.push({
      rubricId: rubric.rubricId,
      rubricVersion: rubric.rubricVersion,
      name: rubric.name,
      description: rubric.description,
      fields,
    });
  }

  const bundle: AnnotationBundle = {
    schemaVersion: 1,
    disposable: true,
    generatedAt: now(),
    scope,
    subject,
    rubrics: rubricBlocks,
    evidenceReferences: subject.evidenceArtifactRefs,
    telemetryCompleteness: subject.telemetryCompletenessSummary,
    missingRequiredEvidence: subject.missingEvidence,
    annotations: {
      effectiveSubmitted,
      drafts,
    },
  };

  if (params.includePreviews) {
    bundle.evidencePreviews = await loadPreviews(
      params.runDirectory ?? null,
      subject,
    );
  }

  return bundle;
}

export async function writeAnnotationBundle(
  evaluationDirectory: string,
  bundle: AnnotationBundle,
): Promise<string> {
  const dir = getAnnotationBundlesDirectory(evaluationDirectory);
  await mkdir(dir, { recursive: true });
  const fileName = `${bundle.scope}-${bundle.subject.evaluationSubjectId.slice(0, 16)}-${bundle.generatedAt.replace(/[:.]/g, "-")}.json`;
  const filePath = path.join(dir, fileName);
  await writeFile(filePath, `${JSON.stringify(bundle, null, 2)}\n`, "utf8");
  return filePath;
}
