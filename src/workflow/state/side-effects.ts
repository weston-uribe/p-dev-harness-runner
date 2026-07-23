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

/** True when plan_review_dispatch is durably dispatched or fully completed. */
export function isPlanReviewDispatchDurable(
  state: WorkflowStateRecord,
  identity: string,
): boolean {
  return (state.sideEffects ?? []).some(
    (e) =>
      e.identity === identity && DISPATCH_COMPLETE_STATUSES.has(e.status),
  );
}

export function claimPlanReviewDispatchEffect(
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
    kind: "plan_review_dispatch",
  });
  const current = getSideEffect(withPending, input.identity);
  if (current && DISPATCH_COMPLETE_STATUSES.has(current.status)) {
    return withPending;
  }
  if (
    current?.status === "dispatching" &&
    current.ownerGeneration &&
    current.ownerGeneration !== input.ownerGeneration
  ) {
    return withPending;
  }
  return patchSideEffect(withPending, input.identity, {
    status: "dispatching",
    kind: "plan_review_dispatch",
    ownerGeneration: input.ownerGeneration,
    reviewRequestId: input.reviewRequestId,
    claimedAt: input.claimedAt ?? new Date().toISOString(),
  });
}

export function markPlanReviewDispatchDispatched(
  state: WorkflowStateRecord,
  input: {
    identity: string;
    reviewRequestId: string;
    githubDeliveryId?: string | null;
    dispatchedAt?: string;
    dispatchAttemptCount?: number;
  },
): WorkflowStateRecord {
  const current = getSideEffect(state, input.identity);
  return patchSideEffect(state, input.identity, {
    status: "dispatched",
    kind: "plan_review_dispatch",
    reviewRequestId: input.reviewRequestId,
    githubDeliveryId: input.githubDeliveryId ?? null,
    dispatchedAt: input.dispatchedAt ?? new Date().toISOString(),
    dispatchAttemptCount:
      input.dispatchAttemptCount ??
      (current?.dispatchAttemptCount ?? 0) + 1,
    blockedReason: undefined,
    blockedAt: undefined,
  });
}

export function markPlanReviewDispatchBlocked(
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
    kind: "plan_review_dispatch",
  });
  return patchSideEffect(withPending, input.identity, {
    status: "blocked",
    kind: "plan_review_dispatch",
    reviewRequestId: input.reviewRequestId,
    blockedReason: input.blockedReason,
    blockedAt: input.blockedAt ?? new Date().toISOString(),
  });
}

/** True when implementation_dispatch is durably dispatched or fully completed. */
export function isImplementationDispatchDurable(
  state: WorkflowStateRecord,
  identity: string,
): boolean {
  return (state.sideEffects ?? []).some(
    (e) =>
      e.identity === identity && DISPATCH_COMPLETE_STATUSES.has(e.status),
  );
}

export function claimImplementationDispatchEffect(
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
    kind: "implementation_dispatch",
  });
  const current = getSideEffect(withPending, input.identity);
  if (current && DISPATCH_COMPLETE_STATUSES.has(current.status)) {
    return withPending;
  }
  if (
    current?.status === "dispatching" &&
    current.ownerGeneration &&
    current.ownerGeneration !== input.ownerGeneration
  ) {
    return withPending;
  }
  return patchSideEffect(withPending, input.identity, {
    status: "dispatching",
    kind: "implementation_dispatch",
    ownerGeneration: input.ownerGeneration,
    reviewRequestId: input.reviewRequestId,
    claimedAt: input.claimedAt ?? new Date().toISOString(),
  });
}

export function markImplementationDispatchDispatched(
  state: WorkflowStateRecord,
  input: {
    identity: string;
    reviewRequestId: string;
    githubDeliveryId?: string | null;
    dispatchedAt?: string;
    dispatchAttemptCount?: number;
  },
): WorkflowStateRecord {
  const current = getSideEffect(state, input.identity);
  return patchSideEffect(state, input.identity, {
    status: "dispatched",
    kind: "implementation_dispatch",
    reviewRequestId: input.reviewRequestId,
    githubDeliveryId: input.githubDeliveryId ?? null,
    dispatchedAt: input.dispatchedAt ?? new Date().toISOString(),
    dispatchAttemptCount:
      input.dispatchAttemptCount ??
      (current?.dispatchAttemptCount ?? 0) + 1,
    blockedReason: undefined,
    blockedAt: undefined,
  });
}

export function markImplementationDispatchBlocked(
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
    kind: "implementation_dispatch",
  });
  return patchSideEffect(withPending, input.identity, {
    status: "blocked",
    kind: "implementation_dispatch",
    reviewRequestId: input.reviewRequestId,
    blockedReason: input.blockedReason,
    blockedAt: input.blockedAt ?? new Date().toISOString(),
  });
}

export function markImplementationDispatchCompleted(
  state: WorkflowStateRecord,
  input: {
    identity: string;
    reviewRequestId: string;
    completedAt?: string;
  },
): WorkflowStateRecord {
  return patchSideEffect(state, input.identity, {
    status: "completed",
    kind: "implementation_dispatch",
    reviewRequestId: input.reviewRequestId,
    completedAt: input.completedAt ?? new Date().toISOString(),
  });
}

export function upsertPlanningOnlyTerminalEffect(
  state: WorkflowStateRecord,
  input: {
    identity: string;
    terminalStatusId: string;
    createdAt?: string;
  },
): WorkflowStateRecord {
  const withPending = upsertPendingSideEffect(state, {
    identity: input.identity,
    kind: "planning_only_terminal_transition",
    createdAt: input.createdAt,
  });
  const existing = getSideEffect(withPending, input.identity);
  if (existing?.terminalStatusId === input.terminalStatusId) {
    return withPending;
  }
  return {
    ...withPending,
    sideEffects: (withPending.sideEffects ?? []).map((entry) =>
      entry.identity === input.identity
        ? { ...entry, terminalStatusId: input.terminalStatusId }
        : entry,
    ),
  };
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
