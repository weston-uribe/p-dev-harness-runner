/**
 * Durable decision-and-effects helpers.
 * Accept subject/decision in state first; apply external effects; CAS-mark complete.
 */

import type {
  WorkflowSideEffectKind,
  WorkflowSideEffectRecord,
  WorkflowSideEffectStatus,
  WorkflowStateRecord,
} from "./types.js";

const INCOMPLETE_STATUSES: ReadonlySet<WorkflowSideEffectStatus> = new Set([
  "pending",
  "dispatching",
  "blocked",
]);

const DISPATCH_COMPLETE_STATUSES: ReadonlySet<WorkflowSideEffectStatus> = new Set([
  "dispatched",
  "completed",
]);

export function listIncompleteSideEffects(
  state: WorkflowStateRecord,
): WorkflowSideEffectRecord[] {
  return (state.sideEffects ?? []).filter((e) =>
    INCOMPLETE_STATUSES.has(e.status),
  );
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

/** True when code_review_dispatch is durably dispatched or fully completed. */
export function isCodeReviewDispatchDurable(
  state: WorkflowStateRecord,
  identity: string,
): boolean {
  return (state.sideEffects ?? []).some(
    (e) =>
      e.identity === identity && DISPATCH_COMPLETE_STATUSES.has(e.status),
  );
}

export function getSideEffect(
  state: WorkflowStateRecord,
  identity: string,
): WorkflowSideEffectRecord | null {
  return (state.sideEffects ?? []).find((e) => e.identity === identity) ?? null;
}

export function patchSideEffect(
  state: WorkflowStateRecord,
  identity: string,
  patch: Partial<WorkflowSideEffectRecord> & {
    status: WorkflowSideEffectStatus;
  },
): WorkflowStateRecord {
  const existing = state.sideEffects ?? [];
  const found = existing.some((e) => e.identity === identity);
  if (!found) {
    return {
      ...state,
      sideEffects: [
        ...existing,
        {
          identity,
          kind: "code_review_dispatch",
          createdAt: new Date().toISOString(),
          ...patch,
        },
      ],
    };
  }
  return {
    ...state,
    sideEffects: existing.map((e) =>
      e.identity === identity ? { ...e, ...patch } : e,
    ),
  };
}

export function claimCodeReviewDispatchEffect(
  state: WorkflowStateRecord,
  input: {
    identity: string;
    ownerGeneration: string;
    reviewRequestId: string;
    claimedAt?: string;
  },
): WorkflowStateRecord {
  const withPending = upsertPendingSideEffect(state, {
    identity: input.identity,
    kind: "code_review_dispatch",
  });
  const current = getSideEffect(withPending, input.identity);
  if (
    current &&
    DISPATCH_COMPLETE_STATUSES.has(current.status)
  ) {
    return withPending;
  }
  if (
    current?.status === "dispatching" &&
    current.ownerGeneration &&
    current.ownerGeneration !== input.ownerGeneration
  ) {
    // Another owner already claimed; leave unchanged for the caller to reload.
    return withPending;
  }
  return patchSideEffect(withPending, input.identity, {
    status: "dispatching",
    kind: "code_review_dispatch",
    ownerGeneration: input.ownerGeneration,
    reviewRequestId: input.reviewRequestId,
    claimedAt: input.claimedAt ?? new Date().toISOString(),
  });
}

export function markCodeReviewDispatchDispatched(
  state: WorkflowStateRecord,
  input: {
    identity: string;
    reviewRequestId: string;
    githubDeliveryId?: string | null;
    dispatchedAt?: string;
  },
): WorkflowStateRecord {
  return patchSideEffect(state, input.identity, {
    status: "dispatched",
    kind: "code_review_dispatch",
    reviewRequestId: input.reviewRequestId,
    githubDeliveryId: input.githubDeliveryId ?? null,
    dispatchedAt: input.dispatchedAt ?? new Date().toISOString(),
    blockedReason: undefined,
    blockedAt: undefined,
  });
}

export function markCodeReviewDispatchBlocked(
  state: WorkflowStateRecord,
  input: {
    identity: string;
    blockedReason: string;
    reviewRequestId?: string;
    blockedAt?: string;
  },
): WorkflowStateRecord {
  const withPending = upsertPendingSideEffect(state, {
    identity: input.identity,
    kind: "code_review_dispatch",
  });
  return patchSideEffect(withPending, input.identity, {
    status: "blocked",
    kind: "code_review_dispatch",
    reviewRequestId: input.reviewRequestId,
    blockedReason: input.blockedReason,
    blockedAt: input.blockedAt ?? new Date().toISOString(),
  });
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
