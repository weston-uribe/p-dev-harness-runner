/**
 * Durable code_review_dispatch orchestration shared by handoff and reconcile.
 *
 * Ordering:
 * 1. Resolve deterministic cr-subject:<reviewSubjectIdentity> request id
 * 2. CAS-claim effect as dispatching (reload+retry on claim_lost)
 * 3. Load existing job request; skip HTTP if present
 * 4. Require GITHUB_DISPATCH_TOKEN ?? HARNESS_GITHUB_TOKEN
 * 5. repository_dispatch via createCodeReviewJobAndDispatch
 * 6. CAS-mark dispatched before releasing ownership / Linear projection
 *
 * Never creates a second review subject for the same issue/PR/head/generation/cycle.
 */

import type { WorkflowStateStore } from "./state/index.js";
import type { WorkflowStateRecord } from "./state/types.js";
import {
  buildSideEffectIdentity,
  claimCodeReviewDispatchEffect,
  getSideEffect,
  isCodeReviewDispatchDurable,
  markCodeReviewDispatchBlocked,
  markCodeReviewDispatchDispatched,
} from "./state/side-effects.js";
import {
  createCodeReviewJobAndDispatch,
  redispatchJobRequestById,
} from "./job-request/dispatch-opaque.js";
import { createGithubJobRequestStoreFromEnv } from "./job-request/runtime-store.js";
import { reopenFalseDuplicateJobRequestForRetry } from "./job-request/claim.js";
import { resolveDispatchGithubToken } from "../public-execution/runtime-repos.js";
import { CODE_REVIEW_DISPATCH_MAX_CLAIM_RETRIES } from "./reconcile-health.js";
import { clearActiveRunLeaseIfMatches } from "./state/apply.js";

export const MISSING_DISPATCH_TOKEN_MESSAGE =
  "missing_dispatch_token: GITHUB_DISPATCH_TOKEN is not available to the harness runner. Ensure the managed-runner job sets GITHUB_DISPATCH_TOKEN from secrets.HARNESS_GITHUB_TOKEN, then resume with harness:reconcile-workflow --issue <KEY> --phase code_review --dispatch.";

export function buildCodeReviewRequestId(reviewSubjectIdentity: string): string {
  return `cr-subject:${reviewSubjectIdentity}`;
}

export function buildCodeReviewDispatchEffectId(
  reviewSubjectIdentity: string,
): string {
  return buildSideEffectIdentity({
    kind: "code_review_dispatch",
    subjectIdentity: reviewSubjectIdentity,
  });
}

export type EnsureCodeReviewDispatchOutcome =
  | "already_dispatched"
  | "dispatched"
  | "request_already_present"
  | "missing_dispatch_token"
  | "claim_lost"
  | "conflicting_subject"
  | "decision_already_accepted"
  | "reviewer_already_active"
  | "false_duplicate_recovered";

export type EnsureCodeReviewDispatchResult = {
  outcome: EnsureCodeReviewDispatchOutcome;
  reviewRequestId: string;
  state: WorkflowStateRecord;
  httpDispatched: boolean;
  /** How many claim_lost reload/retries ran before the terminal outcome. */
  claimLostRecoveries: number;
};

/** True when handoff/reconcile may treat Code Review start as durably proven. */
export function isCodeReviewDispatchProven(
  outcome: EnsureCodeReviewDispatchOutcome,
): boolean {
  return (
    outcome === "dispatched" ||
    outcome === "request_already_present" ||
    outcome === "already_dispatched" ||
    outcome === "decision_already_accepted" ||
    outcome === "reviewer_already_active" ||
    outcome === "false_duplicate_recovered"
  );
}

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

function conflictingSubject(
  state: WorkflowStateRecord,
  reviewSubjectIdentity: string,
): boolean {
  const active = state.activeReviewSubjectIdentity?.trim();
  if (!active) return false;
  return active !== reviewSubjectIdentity;
}

function decisionAlreadyAccepted(
  state: WorkflowStateRecord,
  reviewSubjectIdentity: string,
): boolean {
  return Boolean(state.acceptedReviewSubjects?.[reviewSubjectIdentity]);
}

function reviewerAlreadyActive(
  state: WorkflowStateRecord,
  reviewSubjectIdentity: string,
): boolean {
  const leaseIdentity = `code_review:${reviewSubjectIdentity}`;
  const lease = state.activeRunLease;
  if (!lease) return false;
  if (lease.identity !== leaseIdentity) return false;
  if (!lease.expiresAt) return true;
  const expires = Date.parse(lease.expiresAt);
  return Number.isFinite(expires) && expires > Date.now();
}

async function loadExistingRequest(
  reviewRequestId: string,
  env: Record<string, string | undefined>,
): Promise<{ requestId: string } | null> {
  try {
    const jobStore = await createGithubJobRequestStoreFromEnv(env);
    const existing = await jobStore.load(reviewRequestId);
    return existing ? { requestId: reviewRequestId } : null;
  } catch {
    return null;
  }
}

async function attemptDispatchOnce(input: {
  store: WorkflowStateStore;
  issueKey: string;
  reviewSubjectIdentity: string;
  ownerGeneration: string;
  state: WorkflowStateRecord;
  env: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
}): Promise<EnsureCodeReviewDispatchResult> {
  const reviewRequestId = buildCodeReviewRequestId(input.reviewSubjectIdentity);
  const effectId = buildCodeReviewDispatchEffectId(input.reviewSubjectIdentity);
  let state = input.state;

  if (decisionAlreadyAccepted(state, input.reviewSubjectIdentity)) {
    return {
      outcome: "decision_already_accepted",
      reviewRequestId,
      state,
      httpDispatched: false,
      claimLostRecoveries: 0,
    };
  }

  if (reviewerAlreadyActive(state, input.reviewSubjectIdentity)) {
    return {
      outcome: "reviewer_already_active",
      reviewRequestId,
      state,
      httpDispatched: false,
      claimLostRecoveries: 0,
    };
  }

  if (conflictingSubject(state, input.reviewSubjectIdentity)) {
    return {
      outcome: "conflicting_subject",
      reviewRequestId,
      state,
      httpDispatched: false,
      claimLostRecoveries: 0,
    };
  }

  if (isCodeReviewDispatchDurable(state, effectId)) {
    const effect = getSideEffect(state, effectId);
    return {
      outcome: "already_dispatched",
      reviewRequestId: effect?.reviewRequestId ?? reviewRequestId,
      state,
      httpDispatched: false,
      claimLostRecoveries: 0,
    };
  }

  const claimed = claimCodeReviewDispatchEffect(state, {
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
      claimLostRecoveries: 0,
    };
  }

  const afterClaim = await casBump(input.store, input.issueKey, claimed);
  if (!afterClaim) {
    const reloaded = (await input.store.load(input.issueKey)) ?? state;
    if (isCodeReviewDispatchDurable(reloaded, effectId)) {
      return {
        outcome: "already_dispatched",
        reviewRequestId,
        state: reloaded,
        httpDispatched: false,
        claimLostRecoveries: 0,
      };
    }
    const existing = await loadExistingRequest(reviewRequestId, input.env);
    if (existing) {
      return {
        outcome: "request_already_present",
        reviewRequestId,
        state: reloaded,
        httpDispatched: false,
        claimLostRecoveries: 0,
      };
    }
    return {
      outcome: "claim_lost",
      reviewRequestId,
      state: reloaded,
      httpDispatched: false,
      claimLostRecoveries: 0,
    };
  }
  state = afterClaim;

  const existingRequest = await loadExistingRequest(reviewRequestId, input.env);
  if (existingRequest) {
    const marked = markCodeReviewDispatchDispatched(state, {
      identity: effectId,
      reviewRequestId,
    });
    const afterMark = await casBump(input.store, input.issueKey, {
      ...marked,
      activeReviewSubjectIdentity: input.reviewSubjectIdentity,
    });
    return {
      outcome: "request_already_present",
      reviewRequestId,
      state: afterMark ?? {
        ...marked,
        activeReviewSubjectIdentity: input.reviewSubjectIdentity,
      },
      httpDispatched: false,
      claimLostRecoveries: 0,
    };
  }

  const token = resolveDispatchGithubToken(input.env);
  if (!token) {
    const blocked = markCodeReviewDispatchBlocked(state, {
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
      claimLostRecoveries: 0,
    };
  }

  const result = await createCodeReviewJobAndDispatch({
    issueKey: input.issueKey,
    reviewSubjectIdentity: input.reviewSubjectIdentity,
    env: input.env,
    fetchImpl: input.fetchImpl,
    dispatchToken: token,
  });

  const marked = markCodeReviewDispatchDispatched(state, {
    identity: effectId,
    reviewRequestId: result.requestId,
  });
  const next = {
    ...marked,
    activeReviewSubjectIdentity: input.reviewSubjectIdentity,
  };
  const afterMark = await casBump(input.store, input.issueKey, next);
  if (!afterMark) {
    const reloaded = (await input.store.load(input.issueKey)) ?? next;
    const proven = await loadExistingRequest(reviewRequestId, input.env);
    if (proven) {
      const repaired = markCodeReviewDispatchDispatched(reloaded, {
        identity: effectId,
        reviewRequestId,
      });
      const repairedCas = await casBump(input.store, input.issueKey, {
        ...repaired,
        activeReviewSubjectIdentity: input.reviewSubjectIdentity,
      });
      return {
        outcome: "request_already_present",
        reviewRequestId,
        state: repairedCas ?? repaired,
        httpDispatched: false,
        claimLostRecoveries: 0,
      };
    }
    return {
      outcome: "dispatched",
      reviewRequestId: result.requestId,
      state: reloaded,
      httpDispatched: result.dispatched,
      claimLostRecoveries: 0,
    };
  }

  return {
    outcome: "dispatched",
    reviewRequestId: result.requestId,
    state: afterMark,
    httpDispatched: result.dispatched && !result.duplicate,
    claimLostRecoveries: 0,
  };
}

/**
 * Best-effort clear of a leftover implementation lease that blocks Code Review
 * claims after handoff (FRE-7). Never clears a foreign code_review lease.
 */
export async function clearBlockingImplementationLeaseForCodeReview(input: {
  store: WorkflowStateStore;
  issueKey: string;
  state: WorkflowStateRecord;
}): Promise<WorkflowStateRecord> {
  const lease = input.state.activeRunLease;
  if (
    !lease ||
    !(
      lease.phaseId === "implementation" ||
      lease.identity.startsWith("implementation:")
    )
  ) {
    return input.state;
  }
  const cleared = await clearActiveRunLeaseIfMatches({
    store: input.store,
    issueKey: input.issueKey,
    expectedStateRevision: input.state.stateRevision,
    expectedIdentity: lease.identity,
    expectedOwnerRunId: lease.ownerRunId,
    expectedPhaseId: lease.phaseId ?? "implementation",
  });
  return cleared.ok && cleared.state ? cleared.state : input.state;
}

/**
 * FRE-7 recovery: reopen a completed false-duplicate job request for the same
 * subject and redispatch once. Returns null when recovery does not apply.
 */
export async function recoverFalseDuplicateCodeReviewDispatch(input: {
  store: WorkflowStateStore;
  issueKey: string;
  reviewSubjectIdentity: string;
  state: WorkflowStateRecord;
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
}): Promise<EnsureCodeReviewDispatchResult | null> {
  const env = input.env ?? process.env;
  let state = await clearBlockingImplementationLeaseForCodeReview({
    store: input.store,
    issueKey: input.issueKey,
    state: input.state,
  });
  const reviewRequestId = buildCodeReviewRequestId(input.reviewSubjectIdentity);

  if (decisionAlreadyAccepted(state, input.reviewSubjectIdentity)) {
    return null;
  }
  if (reviewerAlreadyActive(state, input.reviewSubjectIdentity)) {
    return null;
  }

  try {
    const jobStore = await createGithubJobRequestStoreFromEnv(env);
    const reopened = await reopenFalseDuplicateJobRequestForRetry(jobStore, {
      requestId: reviewRequestId,
      durableCompletionEvidenceAbsent: true,
    });
    if (!reopened) {
      return null;
    }
    const token = resolveDispatchGithubToken(env);
    if (!token) {
      return {
        outcome: "missing_dispatch_token",
        reviewRequestId,
        state,
        httpDispatched: false,
        claimLostRecoveries: 0,
      };
    }
    const redispatched = await redispatchJobRequestById({
      requestId: reviewRequestId,
      env,
      fetchImpl: input.fetchImpl,
      dispatchToken: token,
    });
    return {
      outcome: "false_duplicate_recovered",
      reviewRequestId,
      state,
      httpDispatched: redispatched.dispatched,
      claimLostRecoveries: 0,
    };
  } catch {
    return null;
  }
}

export async function ensureCodeReviewJobDispatched(input: {
  store: WorkflowStateStore;
  issueKey: string;
  reviewSubjectIdentity: string;
  ownerGeneration: string;
  state: WorkflowStateRecord;
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  maxClaimRetries?: number;
}): Promise<EnsureCodeReviewDispatchResult> {
  const env = input.env ?? process.env;
  const maxRetries =
    input.maxClaimRetries ?? CODE_REVIEW_DISPATCH_MAX_CLAIM_RETRIES;
  let state = await clearBlockingImplementationLeaseForCodeReview({
    store: input.store,
    issueKey: input.issueKey,
    state: input.state,
  });
  let claimLostRecoveries = 0;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const result = await attemptDispatchOnce({
      store: input.store,
      issueKey: input.issueKey,
      reviewSubjectIdentity: input.reviewSubjectIdentity,
      ownerGeneration: input.ownerGeneration,
      state,
      env,
      fetchImpl: input.fetchImpl,
    });

    if (
      result.outcome === "already_dispatched" ||
      result.outcome === "request_already_present"
    ) {
      // FRE-7: durable/present request may be a false-duplicate completion.
      const recovered = await recoverFalseDuplicateCodeReviewDispatch({
        store: input.store,
        issueKey: input.issueKey,
        reviewSubjectIdentity: input.reviewSubjectIdentity,
        state: result.state,
        env,
        fetchImpl: input.fetchImpl,
      });
      if (
        recovered?.outcome === "false_duplicate_recovered" ||
        recovered?.outcome === "missing_dispatch_token"
      ) {
        return { ...recovered, claimLostRecoveries };
      }
    }

    if (result.outcome !== "claim_lost") {
      return { ...result, claimLostRecoveries };
    }

    claimLostRecoveries += 1;
    const reloaded = (await input.store.load(input.issueKey)) ?? result.state;
    state = reloaded;

    // Another actor completed the same deterministic effect/request.
    const effectId = buildCodeReviewDispatchEffectId(
      input.reviewSubjectIdentity,
    );
    if (isCodeReviewDispatchDurable(reloaded, effectId)) {
      return {
        outcome: "already_dispatched",
        reviewRequestId: buildCodeReviewRequestId(input.reviewSubjectIdentity),
        state: reloaded,
        httpDispatched: false,
        claimLostRecoveries,
      };
    }
    if (decisionAlreadyAccepted(reloaded, input.reviewSubjectIdentity)) {
      return {
        outcome: "decision_already_accepted",
        reviewRequestId: buildCodeReviewRequestId(input.reviewSubjectIdentity),
        state: reloaded,
        httpDispatched: false,
        claimLostRecoveries,
      };
    }
    if (reviewerAlreadyActive(reloaded, input.reviewSubjectIdentity)) {
      return {
        outcome: "reviewer_already_active",
        reviewRequestId: buildCodeReviewRequestId(input.reviewSubjectIdentity),
        state: reloaded,
        httpDispatched: false,
        claimLostRecoveries,
      };
    }
    if (conflictingSubject(reloaded, input.reviewSubjectIdentity)) {
      return {
        outcome: "conflicting_subject",
        reviewRequestId: buildCodeReviewRequestId(input.reviewSubjectIdentity),
        state: reloaded,
        httpDispatched: false,
        claimLostRecoveries,
      };
    }
    const existing = await loadExistingRequest(
      buildCodeReviewRequestId(input.reviewSubjectIdentity),
      env,
    );
    if (existing) {
      return {
        outcome: "request_already_present",
        reviewRequestId: existing.requestId,
        state: reloaded,
        httpDispatched: false,
        claimLostRecoveries,
      };
    }
    // Retry CAS against the current revision when no conflicting subject exists.
  }

  return {
    outcome: "claim_lost",
    reviewRequestId: buildCodeReviewRequestId(input.reviewSubjectIdentity),
    state,
    httpDispatched: false,
    claimLostRecoveries,
  };
}
