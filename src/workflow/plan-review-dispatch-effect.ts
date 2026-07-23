/**
 * Durable plan_review_dispatch orchestration shared by planning and reconcile.
 *
 * Ordering (crash-safe):
 * 1. Persist pending plan_review_dispatch effect + subject identity
 * 2. (Caller) project Linear Plan Review when needed
 * 3. CAS-claim effect as dispatching
 * 4. Create/load opaque pr-subject job request
 * 5. repository_dispatch with requestId only
 * 6. CAS-mark dispatched
 */

import type { WorkflowStateStore } from "./state/index.js";
import type { WorkflowStateRecord } from "./state/types.js";
import { isPlanningOnlySuppressed } from "./execution-policy.js";
import {
  buildSideEffectIdentity,
  claimPlanReviewDispatchEffect,
  getSideEffect,
  isPlanReviewDispatchDurable,
  markPlanReviewDispatchBlocked,
  markPlanReviewDispatchDispatched,
  upsertPendingSideEffect,
} from "./state/side-effects.js";
import {
  createPlanReviewJobAndDispatch,
  redispatchJobRequestById,
} from "./job-request/dispatch-opaque.js";
import { createGithubJobRequestStoreFromEnv } from "./job-request/runtime-store.js";
import {
  reopenFailedJobRequestForRetry,
  reopenFalseDuplicateJobRequestForRetry,
} from "./job-request/claim.js";
import { resolveJobRequestId } from "./job-request/request-id.js";
import { resolveDispatchGithubToken } from "../public-execution/runtime-repos.js";
import { PLAN_REVIEW_DISPATCH_MAX_ATTEMPTS } from "./reconcile-health.js";

export const MISSING_PLAN_REVIEW_DISPATCH_TOKEN_MESSAGE =
  "missing_dispatch_token: GITHUB_DISPATCH_TOKEN is not available to the harness runner. Ensure the managed-runner job sets GITHUB_DISPATCH_TOKEN from secrets.HARNESS_GITHUB_TOKEN, then resume with harness:reconcile-workflow --issue <KEY> --dispatch.";

export function buildPlanReviewDeliveryId(reviewSubjectIdentity: string): string {
  return `pr-subject:${reviewSubjectIdentity}`;
}

export function buildPlanReviewRequestId(reviewSubjectIdentity: string): string {
  return resolveJobRequestId({
    linearDeliveryId: buildPlanReviewDeliveryId(reviewSubjectIdentity),
  });
}

export function buildPlanReviewDispatchEffectId(
  reviewSubjectIdentity: string,
): string {
  return buildSideEffectIdentity({
    kind: "plan_review_dispatch",
    subjectIdentity: reviewSubjectIdentity,
  });
}

export type EnsurePlanReviewDispatchResult =
  | {
      outcome: "already_dispatched";
      reviewRequestId: string;
      state: WorkflowStateRecord;
      httpDispatched: false;
    }
  | {
      outcome: "dispatched";
      reviewRequestId: string;
      state: WorkflowStateRecord;
      httpDispatched: boolean;
    }
  | {
      outcome: "request_already_present";
      reviewRequestId: string;
      state: WorkflowStateRecord;
      httpDispatched: false;
    }
  | {
      outcome: "missing_dispatch_token";
      reviewRequestId: string;
      state: WorkflowStateRecord;
      httpDispatched: false;
    }
  | {
      outcome: "claim_lost";
      reviewRequestId: string;
      state: WorkflowStateRecord;
      httpDispatched: false;
    }
  | {
      outcome: "max_attempts_exhausted";
      reviewRequestId: string;
      state: WorkflowStateRecord;
      httpDispatched: false;
    }
  | {
      outcome: "unresolved_decision_recovered";
      reviewRequestId: string;
      state: WorkflowStateRecord;
      httpDispatched: boolean;
    };

async function casBump(
  store: WorkflowStateStore,
  issueKey: string,
  state: WorkflowStateRecord,
): Promise<WorkflowStateRecord | null> {
  const nextRevision = state.stateRevision + 1;
  const next = { ...state, stateRevision: nextRevision };
  const ok = await store.compareAndSet({
    issueKey,
    expectedRevision: state.stateRevision,
    next,
  });
  if (!ok) {
    return null;
  }
  return next;
}

/** Persist pending effect + subject before Linear projection (crash boundary). */
export async function ensurePlanReviewDispatchPending(input: {
  store: WorkflowStateStore;
  issueKey: string;
  reviewSubjectIdentity: string;
  state: WorkflowStateRecord;
}): Promise<WorkflowStateRecord> {
  if (isPlanningOnlySuppressed(input.state)) {
    return input.state;
  }
  const effectId = buildPlanReviewDispatchEffectId(input.reviewSubjectIdentity);
  const reviewRequestId = buildPlanReviewRequestId(input.reviewSubjectIdentity);
  let state: WorkflowStateRecord = {
    ...input.state,
    planReviewSubjectIdentity: input.reviewSubjectIdentity,
  };
  state = upsertPendingSideEffect(state, {
    identity: effectId,
    kind: "plan_review_dispatch",
  });
  const effect = getSideEffect(state, effectId);
  if (effect && !effect.reviewRequestId) {
    state = {
      ...state,
      sideEffects: (state.sideEffects ?? []).map((e) =>
        e.identity === effectId
          ? { ...e, reviewRequestId }
          : e,
      ),
    };
  }
  const contentChanged =
    state.planReviewSubjectIdentity !== input.state.planReviewSubjectIdentity ||
    JSON.stringify(state.sideEffects) !== JSON.stringify(input.state.sideEffects);
  if (!contentChanged) {
    return state;
  }
  const after = await casBump(input.store, input.issueKey, state);
  return after ?? state;
}

export async function ensurePlanReviewJobDispatched(input: {
  store: WorkflowStateStore;
  issueKey: string;
  reviewSubjectIdentity: string;
  ownerGeneration: string;
  state: WorkflowStateRecord;
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
}): Promise<EnsurePlanReviewDispatchResult> {
  if (isPlanningOnlySuppressed(input.state)) {
    return {
      outcome: "already_dispatched",
      reviewRequestId: buildPlanReviewRequestId(input.reviewSubjectIdentity),
      state: input.state,
      httpDispatched: false,
    };
  }
  const env = input.env ?? process.env;
  const reviewRequestId = buildPlanReviewRequestId(input.reviewSubjectIdentity);
  const effectId = buildPlanReviewDispatchEffectId(input.reviewSubjectIdentity);
  let state: WorkflowStateRecord = {
    ...input.state,
    planReviewSubjectIdentity: input.reviewSubjectIdentity,
  };

  if (isPlanReviewDispatchDurable(state, effectId)) {
    const effect = getSideEffect(state, effectId);
    return {
      outcome: "already_dispatched",
      reviewRequestId: effect?.reviewRequestId ?? reviewRequestId,
      state,
      httpDispatched: false,
    };
  }

  const existingEffect = getSideEffect(state, effectId);
  if (
    (existingEffect?.dispatchAttemptCount ?? 0) >= PLAN_REVIEW_DISPATCH_MAX_ATTEMPTS &&
    existingEffect?.status === "blocked"
  ) {
    return {
      outcome: "max_attempts_exhausted",
      reviewRequestId: existingEffect.reviewRequestId ?? reviewRequestId,
      state,
      httpDispatched: false,
    };
  }

  const claimed = claimPlanReviewDispatchEffect(state, {
    identity: effectId,
    ownerGeneration: input.ownerGeneration,
    reviewRequestId,
  });
  const claimedEffect = getSideEffect(claimed, effectId);
  if (
    claimedEffect?.status === "dispatching" &&
    claimedEffect.ownerGeneration &&
    claimedEffect.ownerGeneration !== input.ownerGeneration
  ) {
    return {
      outcome: "claim_lost",
      reviewRequestId,
      state,
      httpDispatched: false,
    };
  }

  const afterClaim = await casBump(input.store, input.issueKey, claimed);
  if (!afterClaim) {
    const reloaded = (await input.store.load(input.issueKey)) ?? state;
    if (isPlanReviewDispatchDurable(reloaded, effectId)) {
      return {
        outcome: "already_dispatched",
        reviewRequestId,
        state: reloaded,
        httpDispatched: false,
      };
    }
    return {
      outcome: "claim_lost",
      reviewRequestId,
      state: reloaded,
      httpDispatched: false,
    };
  }
  state = afterClaim;

  let existingRequest = null;
  try {
    const jobStore = await createGithubJobRequestStoreFromEnv(env);
    existingRequest = await jobStore.load(reviewRequestId);
  } catch {
    existingRequest = null;
  }

  if (existingRequest) {
    const marked = markPlanReviewDispatchDispatched(state, {
      identity: effectId,
      reviewRequestId,
      dispatchAttemptCount: existingEffect?.dispatchAttemptCount ?? 0,
    });
    const afterMark = await casBump(input.store, input.issueKey, marked);
    return {
      outcome: "request_already_present",
      reviewRequestId,
      state: afterMark ?? marked,
      httpDispatched: false,
    };
  }

  const token = resolveDispatchGithubToken(env);
  if (!token) {
    const blocked = markPlanReviewDispatchBlocked(state, {
      identity: effectId,
      blockedReason: "missing_dispatch_token",
      reviewRequestId,
    });
    const afterBlock = await casBump(input.store, input.issueKey, blocked);
    return {
      outcome: "missing_dispatch_token",
      reviewRequestId,
      state: afterBlock ?? blocked,
      httpDispatched: false,
    };
  }

  const attempts = (getSideEffect(state, effectId)?.dispatchAttemptCount ?? 0) + 1;
  if (attempts > PLAN_REVIEW_DISPATCH_MAX_ATTEMPTS) {
    const blocked = markPlanReviewDispatchBlocked(state, {
      identity: effectId,
      blockedReason: "max_dispatch_attempts_exhausted",
      reviewRequestId,
    });
    const afterBlock = await casBump(input.store, input.issueKey, blocked);
    return {
      outcome: "max_attempts_exhausted",
      reviewRequestId,
      state: afterBlock ?? blocked,
      httpDispatched: false,
    };
  }

  const result = await createPlanReviewJobAndDispatch({
    issueKey: input.issueKey,
    reviewSubjectIdentity: input.reviewSubjectIdentity,
    env,
    fetchImpl: input.fetchImpl,
    dispatchToken: token,
  });

  const marked = markPlanReviewDispatchDispatched(state, {
    identity: effectId,
    reviewRequestId: result.requestId,
    dispatchAttemptCount: attempts,
  });
  const afterMark = await casBump(input.store, input.issueKey, marked);
  if (!afterMark) {
    const reloaded = (await input.store.load(input.issueKey)) ?? marked;
    try {
      const jobStore = await createGithubJobRequestStoreFromEnv(env);
      const proven = await jobStore.load(reviewRequestId);
      if (proven) {
        const repaired = markPlanReviewDispatchDispatched(reloaded, {
          identity: effectId,
          reviewRequestId,
          dispatchAttemptCount: attempts,
        });
        const repairedCas = await casBump(input.store, input.issueKey, repaired);
        return {
          outcome: "request_already_present",
          reviewRequestId,
          state: repairedCas ?? repaired,
          httpDispatched: false,
        };
      }
    } catch {
      // fall through
    }
    return {
      outcome: "dispatched",
      reviewRequestId: result.requestId,
      state: reloaded,
      httpDispatched: result.dispatched,
    };
  }

  return {
    outcome: "dispatched",
    reviewRequestId: result.requestId,
    state: afterMark,
    httpDispatched: result.dispatched && !result.duplicate,
  };
}

/**
 * FRE-8 recovery: when a Plan Reviewer finished without an accepted decision,
 * reopen the same-subject job request and redispatch so the phase can reparse
 * artifacts / run one decision-only repair. Never invents a second subject.
 */
export async function recoverUnresolvedPlanReviewDispatch(input: {
  store: WorkflowStateStore;
  issueKey: string;
  reviewSubjectIdentity: string;
  state: WorkflowStateRecord;
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
}): Promise<EnsurePlanReviewDispatchResult | null> {
  const env = input.env ?? process.env;
  const reviewRequestId = buildPlanReviewRequestId(input.reviewSubjectIdentity);
  const state = input.state;

  if (state.acceptedReviewSubjects?.[input.reviewSubjectIdentity]) {
    return null;
  }
  // Prefer reparse via existing reviewer; require durable agent id.
  if (!state.planReviewerAgentId?.trim()) {
    return null;
  }

  try {
    const jobStore = await createGithubJobRequestStoreFromEnv(env);
    const existing = await jobStore.load(reviewRequestId);
    if (!existing) {
      return null;
    }
    // Pending/claimed with a finished reviewer + no accepted decision means the
    // prior execution terminalized without binding a decision (FRE-8). Redispatch
    // the same subject/request so the phase can reparse artifacts / repair.
    if (existing.state !== "pending" && existing.state !== "claimed") {
      const reopened =
        (await reopenFailedJobRequestForRetry(jobStore, {
          requestId: reviewRequestId,
        })) ??
        (await reopenFalseDuplicateJobRequestForRetry(jobStore, {
          requestId: reviewRequestId,
          durableCompletionEvidenceAbsent: true,
        }));
      if (!reopened) {
        return null;
      }
    }
    const token = resolveDispatchGithubToken(env);
    if (!token) {
      return {
        outcome: "missing_dispatch_token",
        reviewRequestId,
        state,
        httpDispatched: false,
      };
    }
    const redispatched = await redispatchJobRequestById({
      requestId: reviewRequestId,
      env,
      fetchImpl: input.fetchImpl,
      dispatchToken: token,
    });
    return {
      outcome: "unresolved_decision_recovered",
      reviewRequestId,
      state,
      httpDispatched: redispatched.dispatched,
    };
  } catch {
    return null;
  }
}
