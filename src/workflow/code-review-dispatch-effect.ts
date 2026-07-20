/**
 * Durable code_review_dispatch orchestration shared by handoff and reconcile.
 *
 * Ordering:
 * 1. Resolve deterministic cr-subject:<reviewSubjectIdentity> request id
 * 2. CAS-claim effect as dispatching
 * 3. Load existing job request; skip HTTP if present
 * 4. Require GITHUB_DISPATCH_TOKEN ?? HARNESS_GITHUB_TOKEN
 * 5. repository_dispatch via createCodeReviewJobAndDispatch
 * 6. CAS-mark dispatched before releasing ownership / Linear projection
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
import { createCodeReviewJobAndDispatch } from "./job-request/dispatch-opaque.js";
import { createGithubJobRequestStoreFromEnv } from "./job-request/runtime-store.js";
import { resolveDispatchGithubToken } from "../public-execution/runtime-repos.js";

export const MISSING_DISPATCH_TOKEN_MESSAGE =
  "missing_dispatch_token: GITHUB_DISPATCH_TOKEN is not available to the harness runner. Ensure the managed-runner job sets GITHUB_DISPATCH_TOKEN from secrets.HARNESS_GITHUB_TOKEN, then resume with harness:reconcile-workflow --issue <KEY> --dispatch.";

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

export type EnsureCodeReviewDispatchResult =
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

export async function ensureCodeReviewJobDispatched(input: {
  store: WorkflowStateStore;
  issueKey: string;
  reviewSubjectIdentity: string;
  ownerGeneration: string;
  state: WorkflowStateRecord;
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
}): Promise<EnsureCodeReviewDispatchResult> {
  const env = input.env ?? process.env;
  const reviewRequestId = buildCodeReviewRequestId(input.reviewSubjectIdentity);
  const effectId = buildCodeReviewDispatchEffectId(input.reviewSubjectIdentity);
  let state = input.state;

  if (isCodeReviewDispatchDurable(state, effectId)) {
    const effect = getSideEffect(state, effectId);
    return {
      outcome: "already_dispatched",
      reviewRequestId: effect?.reviewRequestId ?? reviewRequestId,
      state,
      httpDispatched: false,
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
    const marked = markCodeReviewDispatchDispatched(state, {
      identity: effectId,
      reviewRequestId,
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
    };
  }

  const result = await createCodeReviewJobAndDispatch({
    issueKey: input.issueKey,
    reviewSubjectIdentity: input.reviewSubjectIdentity,
    env,
    fetchImpl: input.fetchImpl,
    dispatchToken: token,
  });

  const marked = markCodeReviewDispatchDispatched(state, {
    identity: effectId,
    reviewRequestId: result.requestId,
  });
  let next = {
    ...marked,
    activeReviewSubjectIdentity: input.reviewSubjectIdentity,
  };
  const afterMark = await casBump(input.store, input.issueKey, next);
  if (!afterMark) {
    // HTTP may have succeeded; prove by request identity on reload.
    const reloaded = (await input.store.load(input.issueKey)) ?? next;
    try {
      const jobStore = await createGithubJobRequestStoreFromEnv(env);
      const proven = await jobStore.load(reviewRequestId);
      if (proven) {
        const repaired = markCodeReviewDispatchDispatched(reloaded, {
          identity: effectId,
          reviewRequestId,
        });
        const repairedCas = await casBump(
          input.store,
          input.issueKey,
          {
            ...repaired,
            activeReviewSubjectIdentity: input.reviewSubjectIdentity,
          },
        );
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
