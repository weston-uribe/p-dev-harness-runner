/**
 * Durable decision-and-effects helpers.
 * Accept subject/decision in state first; apply external effects; CAS-mark complete.
 */

import type {
  WorkflowSideEffectKind,
  WorkflowSideEffectRecord,
  WorkflowStateRecord,
} from "./types.js";

export function listIncompleteSideEffects(
  state: WorkflowStateRecord,
): WorkflowSideEffectRecord[] {
  return (state.sideEffects ?? []).filter((e) => e.status === "pending");
}

export function upsertPendingSideEffect(
  state: WorkflowStateRecord,
  effect: {
    identity: string;
    kind: WorkflowSideEffectKind;
    createdAt?: string;
  },
): WorkflowStateRecord {
  const existing = state.sideEffects ?? [];
  if (existing.some((e) => e.identity === effect.identity)) {
    return state;
  }
  const next: WorkflowSideEffectRecord = {
    identity: effect.identity,
    kind: effect.kind,
    status: "pending",
    createdAt: effect.createdAt ?? new Date().toISOString(),
  };
  return {
    ...state,
    sideEffects: [...existing, next],
  };
}

export function markSideEffectCompleted(
  state: WorkflowStateRecord,
  identity: string,
  completedAt = new Date().toISOString(),
): WorkflowStateRecord {
  const existing = state.sideEffects ?? [];
  return {
    ...state,
    sideEffects: existing.map((e) =>
      e.identity === identity
        ? { ...e, status: "completed" as const, completedAt }
        : e,
    ),
  };
}

export function isSideEffectCompleted(
  state: WorkflowStateRecord,
  identity: string,
): boolean {
  return (state.sideEffects ?? []).some(
    (e) => e.identity === identity && e.status === "completed",
  );
}

export function buildSideEffectIdentity(parts: {
  kind: WorkflowSideEffectKind;
  subjectIdentity: string;
  detail?: string;
}): string {
  return [parts.kind, parts.subjectIdentity, parts.detail ?? ""]
    .filter(Boolean)
    .join(":");
}
