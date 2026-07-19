import type { HumanAnnotation } from "./types.js";

export interface DerivedAnnotationState {
  annotation: HumanAnnotation;
  superseded: boolean;
  invalidated: boolean;
}

/**
 * Derive superseded/invalidated from later immutable records.
 * Historical rows are never rewritten.
 */
export function deriveAnnotationStates(
  annotations: HumanAnnotation[],
): Map<string, DerivedAnnotationState> {
  const byId = new Map<string, DerivedAnnotationState>();
  const ordered = [...annotations].sort((a, b) =>
    a.createdAt.localeCompare(b.createdAt),
  );

  for (const annotation of ordered) {
    byId.set(annotation.annotationId, {
      annotation,
      superseded: false,
      invalidated: false,
    });
  }

  for (const annotation of ordered) {
    if (annotation.supersedesAnnotationId) {
      const prior = byId.get(annotation.supersedesAnnotationId);
      if (prior) prior.superseded = true;
    }
    if (annotation.invalidatesAnnotationId) {
      const prior = byId.get(annotation.invalidatesAnnotationId);
      if (prior) prior.invalidated = true;
    }
  }

  return byId;
}

function keyOf(
  evaluationSubjectId: string,
  rubricId: string,
  rubricVersion: string,
  dimensionId: string,
): string {
  return `${evaluationSubjectId}\0${rubricId}\0${rubricVersion}\0${dimensionId}`;
}

export function getEffectiveSubmittedAnnotation(
  annotations: HumanAnnotation[],
  params: {
    evaluationSubjectId: string;
    rubricId: string;
    rubricVersion: string;
    dimensionId: string;
  },
): HumanAnnotation | null {
  const states = deriveAnnotationStates(annotations);
  const candidates = [...states.values()]
    .filter(
      (s) =>
        s.annotation.evaluationSubjectId === params.evaluationSubjectId &&
        s.annotation.rubricId === params.rubricId &&
        s.annotation.rubricVersion === params.rubricVersion &&
        s.annotation.dimensionId === params.dimensionId &&
        s.annotation.status === "submitted" &&
        !s.superseded &&
        !s.invalidated,
    )
    .map((s) => s.annotation)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return candidates.length > 0 ? candidates[candidates.length - 1]! : null;
}

export function getLatestDraftAnnotation(
  annotations: HumanAnnotation[],
  params: {
    evaluationSubjectId: string;
    rubricId: string;
    rubricVersion: string;
    dimensionId: string;
  },
): HumanAnnotation | null {
  const states = deriveAnnotationStates(annotations);
  const candidates = [...states.values()]
    .filter(
      (s) =>
        s.annotation.evaluationSubjectId === params.evaluationSubjectId &&
        s.annotation.rubricId === params.rubricId &&
        s.annotation.rubricVersion === params.rubricVersion &&
        s.annotation.dimensionId === params.dimensionId &&
        s.annotation.status === "draft" &&
        !s.invalidated,
    )
    .map((s) => s.annotation)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return candidates.length > 0 ? candidates[candidates.length - 1]! : null;
}

export function indexEffectiveSubmitted(
  annotations: HumanAnnotation[],
): Map<string, HumanAnnotation> {
  const states = deriveAnnotationStates(annotations);
  const latest = new Map<string, HumanAnnotation>();
  for (const state of states.values()) {
    if (
      state.annotation.status !== "submitted" ||
      state.superseded ||
      state.invalidated
    ) {
      continue;
    }
    const key = keyOf(
      state.annotation.evaluationSubjectId,
      state.annotation.rubricId,
      state.annotation.rubricVersion,
      state.annotation.dimensionId,
    );
    const existing = latest.get(key);
    if (!existing || state.annotation.createdAt > existing.createdAt) {
      latest.set(key, state.annotation);
    }
  }
  return latest;
}
