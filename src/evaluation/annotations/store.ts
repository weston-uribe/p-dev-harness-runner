import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  getCorrectedOutputsDirectory,
  getEvaluationAnnotationsPath,
} from "../../artifacts/paths.js";
import { redactSecrets } from "../../artifacts/redact.js";
import { boundString } from "../telemetry/bounds.js";
import { buildArtifactRefFromContent } from "../telemetry/artifact-ref.js";
import { getRubric } from "../rubrics/load.js";
import { readSubjects } from "../subjects/writer.js";
import {
  deriveAnnotationId,
  deriveAnnotationIdempotencyKey,
  generateAnnotationNonce,
} from "./ids.js";
import {
  assertHumanAnnotation,
  isFiniteConfidence,
  validateAnnotationAgainstRubric,
} from "./validate.js";
import type { AnnotationInput, HumanAnnotation } from "./types.js";
import { ANNOTATION_SCHEMA_VERSION } from "./types.js";

const MAX_COMMENT_CHARS = 4_000;
const MAX_CORRECTED_OUTPUT_CHARS = 32_000;

export async function readAnnotations(
  evaluationDirectory: string,
): Promise<HumanAnnotation[]> {
  const filePath = getEvaluationAnnotationsPath(evaluationDirectory);
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const out: HumanAnnotation[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    out.push(assertHumanAnnotation(JSON.parse(trimmed)));
  }
  return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export interface AppendAnnotationResult {
  annotation: HumanAnnotation;
  reusedExisting: boolean;
}

export async function appendAnnotation(params: {
  evaluationDirectory: string;
  input: AnnotationInput;
  now?: () => string;
}): Promise<AppendAnnotationResult> {
  const now = params.now ?? (() => new Date().toISOString());
  const createdAt = now();
  const source = params.input.source ?? "human_local";
  if (source !== "human_local" && source !== "human_langfuse") {
    throw new Error(
      `Invalid annotation source: ${String(source)}. Only human_local and human_langfuse are allowed.`,
    );
  }
  if (!isFiniteConfidence(params.input.confidence)) {
    throw new Error("confidence must be a finite number from 0 through 1");
  }

  await mkdir(params.evaluationDirectory, { recursive: true });
  const existing = await readAnnotations(params.evaluationDirectory);

  if (params.input.clientRequestId) {
    const idempotencyKey = deriveAnnotationIdempotencyKey({
      evaluationSubjectId: params.input.evaluationSubjectId,
      rubricId: params.input.rubricId,
      rubricVersion: params.input.rubricVersion,
      dimensionId: params.input.dimensionId,
      clientRequestId: params.input.clientRequestId,
    });
    const prior = existing.find((a) => a.idempotencyKey === idempotencyKey);
    if (prior) {
      return { annotation: prior, reusedExisting: true };
    }
  }

  const subjects = await readSubjects(params.evaluationDirectory);
  const subject = subjects.find(
    (s) => s.evaluationSubjectId === params.input.evaluationSubjectId,
  );
  if (!subject) {
    throw new Error(
      `Unknown evaluationSubjectId: ${params.input.evaluationSubjectId}`,
    );
  }

  const rubric = await getRubric(
    params.input.rubricId,
    params.input.rubricVersion,
  );
  if (!rubric) {
    throw new Error(
      `Unknown rubric ${params.input.rubricId}@${params.input.rubricVersion}`,
    );
  }

  const annotationIds = new Set(existing.map((a) => a.annotationId));
  if (
    params.input.supersedesAnnotationId &&
    !annotationIds.has(params.input.supersedesAnnotationId)
  ) {
    throw new Error(
      `supersedesAnnotationId not found: ${params.input.supersedesAnnotationId}`,
    );
  }
  if (
    params.input.invalidatesAnnotationId &&
    !annotationIds.has(params.input.invalidatesAnnotationId)
  ) {
    throw new Error(
      `invalidatesAnnotationId not found: ${params.input.invalidatesAnnotationId}`,
    );
  }

  let correctedOutputArtifactRef = params.input.correctedOutputArtifactRef;
  if (params.input.correctedOutput != null) {
    const bounded = boundString(
      redactSecrets(params.input.correctedOutput),
      MAX_CORRECTED_OUTPUT_CHARS,
    );
    if (!bounded) {
      throw new Error("correctedOutput empty after redaction/bounds");
    }
    const correctedDir = getCorrectedOutputsDirectory(
      params.evaluationDirectory,
    );
    await mkdir(correctedDir, { recursive: true });
    const fileName = `${createdAt.replace(/[:.]/g, "-")}-${params.input.dimensionId}.md`;
    const absolutePath = path.join(correctedDir, fileName);
    await writeFile(absolutePath, `${bounded}\n`, "utf8");
    correctedOutputArtifactRef = buildArtifactRefFromContent({
      artifactKind: "other",
      artifactPath: path
        .relative(params.evaluationDirectory, absolutePath)
        .split(path.sep)
        .join("/"),
      content: bounded,
      redactionStatus: "redacted_and_bounded",
    });
  }

  const nonce = generateAnnotationNonce();
  const annotationId =
    params.input.preserveAnnotationId ??
    deriveAnnotationId({
      evaluationSubjectId: params.input.evaluationSubjectId,
      rubricId: params.input.rubricId,
      rubricVersion: params.input.rubricVersion,
      dimensionId: params.input.dimensionId,
      createdAt,
      nonce,
    });

  if (annotationIds.has(annotationId)) {
    throw new Error(`Duplicate annotationId rejected: ${annotationId}`);
  }

  const comment = params.input.reviewerComment
    ? boundString(redactSecrets(params.input.reviewerComment), MAX_COMMENT_CHARS)
    : undefined;

  const annotation: HumanAnnotation = {
    annotationSchemaVersion: ANNOTATION_SCHEMA_VERSION,
    annotationId,
    evaluationSubjectId: params.input.evaluationSubjectId,
    rubricId: params.input.rubricId,
    rubricVersion: params.input.rubricVersion,
    dimensionId: params.input.dimensionId,
    judgmentStatus: params.input.judgmentStatus,
    value: params.input.value,
    reviewerRole: params.input.reviewerRole,
    reviewerId: params.input.reviewerId,
    confidence: params.input.confidence,
    reviewerComment: comment,
    correctedOutputArtifactRef,
    evidenceReviewed: params.input.evidenceReviewed,
    createdAt,
    supersedesAnnotationId: params.input.supersedesAnnotationId,
    invalidatesAnnotationId: params.input.invalidatesAnnotationId,
    source,
    status: params.input.status,
    clientRequestId: params.input.clientRequestId,
    idempotencyKey: params.input.clientRequestId
      ? deriveAnnotationIdempotencyKey({
          evaluationSubjectId: params.input.evaluationSubjectId,
          rubricId: params.input.rubricId,
          rubricVersion: params.input.rubricVersion,
          dimensionId: params.input.dimensionId,
          clientRequestId: params.input.clientRequestId,
        })
      : undefined,
  };

  const rubricErrors = validateAnnotationAgainstRubric({ annotation, rubric });
  if (rubricErrors.length > 0) {
    throw new Error(`Annotation validation failed: ${rubricErrors.join("; ")}`);
  }

  assertHumanAnnotation(annotation);

  const filePath = getEvaluationAnnotationsPath(params.evaluationDirectory);
  await appendFile(filePath, `${JSON.stringify(annotation)}\n`, "utf8");
  return { annotation, reusedExisting: false };
}

export async function validateAnnotationsStore(
  evaluationDirectory: string,
): Promise<{ ok: boolean; errors: string[] }> {
  const errors: string[] = [];
  let annotations: HumanAnnotation[];
  try {
    annotations = await readAnnotations(evaluationDirectory);
  } catch (error) {
    return {
      ok: false,
      errors: [error instanceof Error ? error.message : String(error)],
    };
  }

  const ids = new Set<string>();
  for (const annotation of annotations) {
    if (ids.has(annotation.annotationId)) {
      errors.push(`duplicate annotationId: ${annotation.annotationId}`);
    }
    ids.add(annotation.annotationId);
    const rubric = await getRubric(annotation.rubricId, annotation.rubricVersion);
    if (!rubric) {
      errors.push(
        `${annotation.annotationId}: unknown rubric ${annotation.rubricId}@${annotation.rubricVersion}`,
      );
      continue;
    }
    errors.push(
      ...validateAnnotationAgainstRubric({ annotation, rubric }).map(
        (e) => `${annotation.annotationId}: ${e}`,
      ),
    );
  }

  for (const annotation of annotations) {
    if (
      annotation.supersedesAnnotationId &&
      !ids.has(annotation.supersedesAnnotationId)
    ) {
      errors.push(
        `${annotation.annotationId}: supersedes unknown ${annotation.supersedesAnnotationId}`,
      );
    }
    if (
      annotation.invalidatesAnnotationId &&
      !ids.has(annotation.invalidatesAnnotationId)
    ) {
      errors.push(
        `${annotation.annotationId}: invalidates unknown ${annotation.invalidatesAnnotationId}`,
      );
    }
  }

  return { ok: errors.length === 0, errors };
}
