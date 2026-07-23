/**
 * Durable implementation_dispatch orchestration shared by webhook and reconcile.
 *
 * Ordering (crash-safe):
 * 1. Persist pending implementation_dispatch effect + subject identity
 * 2. CAS-claim effect as dispatching
 * 3. Create/load opaque impl-subject job request
 * 4. repository_dispatch with requestId only
 * 5. CAS-mark dispatched
 */

import type { WorkflowStateStore } from "./state/index.js";
import type { WorkflowStateRecord } from "./state/types.js";
import { isPlanningOnlySuppressed } from "./execution-policy.js";
import {
  buildSideEffectIdentity,
  claimImplementationDispatchEffect,
  getSideEffect,
  isImplementationDispatchDurable,
  markImplementationDispatchBlocked,
  markImplementationDispatchDispatched,
  upsertPendingSideEffect,
} from "./state/side-effects.js";
import { createImplementationJobAndDispatch } from "./job-request/dispatch-opaque.js";
import { createGithubJobRequestStoreFromEnv } from "./job-request/runtime-store.js";
import { resolveJobRequestId } from "./job-request/request-id.js";
import { resolveDispatchGithubToken } from "../public-execution/runtime-repos.js";
import { IMPLEMENTATION_DISPATCH_MAX_ATTEMPTS } from "./reconcile-health.js";

export const MISSING_IMPLEMENTATION_DISPATCH_TOKEN_MESSAGE =
  "missing_dispatch_token: GITHUB_DISPATCH_TOKEN is not available to the harness runner. Ensure the managed-runner job sets GITHUB_DISPATCH_TOKEN from secrets.HARNESS_GITHUB_TOKEN, then resume with harness:reconcile-workflow --issue <KEY> --dispatch.";

export function buildImplementationDeliveryId(
  implementationSubjectIdentity: string,
): string {
  return `impl-subject:${implementationSubjectIdentity}`;
}

export function buildImplementationRequestId(
  implementationSubjectIdentity: string,
): string {
  return resolveJobRequestId({
    linearDeliveryId: buildImplementationDeliveryId(implementationSubjectIdentity),
  });
}

export function buildImplementationDispatchEffectId(
  implementationSubjectIdentity: string,
): string {
  return buildSideEffectIdentity({
    kind: "implementation_dispatch",
    subjectIdentity: implementationSubjectIdentity,
  });
}

export type EnsureImplementationDispatchResult =
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
      outcome: "subject_already_complete";
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

/** Persist pending effect + subject before dispatch (crash boundary). */
export async function ensureImplementationDispatchPending(input: {
  store: WorkflowStateStore;
  issueKey: string;
  implementationSubjectIdentity: string;
  state: WorkflowStateRecord;
}): Promise<WorkflowStateRecord> {
  if (isPlanningOnlySuppressed(input.state)) {
    return input.state;
  }
  const effectId = buildImplementationDispatchEffectId(
    input.implementationSubjectIdentity,
  );
  const reviewRequestId = buildImplementationRequestId(
    input.implementationSubjectIdentity,
  );
  let state: WorkflowStateRecord = {
    ...input.state,
    implementationSubjectIdentity: input.implementationSubjectIdentity,
  };
  state = upsertPendingSideEffect(state, {
    identity: effectId,
    kind: "implementation_dispatch",
  });
  const effect = getSideEffect(state, effectId);
  if (effect && !effect.reviewRequestId) {
    state = {
      ...state,
      sideEffects: (state.sideEffects ?? []).map((e) =>
        e.identity === effectId ? { ...e, reviewRequestId } : e,
      ),
    };
  }
  const contentChanged =
    state.implementationSubjectIdentity !==
      input.state.implementationSubjectIdentity ||
    JSON.stringify(state.sideEffects) !== JSON.stringify(input.state.sideEffects);
  if (!contentChanged) {
    return state;
  }
  const after = await casBump(input.store, input.issueKey, state);
  return after ?? state;
}

export async function ensureImplementationJobDispatched(input: {
  store: WorkflowStateStore;
  issueKey: string;
  implementationSubjectIdentity: string;
  ownerGeneration: string;
  state: WorkflowStateRecord;
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
}): Promise<EnsureImplementationDispatchResult> {
  if (isPlanningOnlySuppressed(input.state)) {
    return {
      outcome: "already_dispatched",
      reviewRequestId: buildImplementationRequestId(
        input.implementationSubjectIdentity,
      ),
      state: input.state,
      httpDispatched: false,
    };
  }
  const env = input.env ?? process.env;
  const reviewRequestId = buildImplementationRequestId(
    input.implementationSubjectIdentity,
  );
  const effectId = buildImplementationDispatchEffectId(
    input.implementationSubjectIdentity,
  );
  let state: WorkflowStateRecord = {
    ...input.state,
    implementationSubjectIdentity: input.implementationSubjectIdentity,
  };

  // Already have a completed build artifact for this subject — no re-dispatch.
  if (
    state.latestImplementationArtifact &&
    state.implementationSubjectIdentity ===
      input.implementationSubjectIdentity
  ) {
    const effect = getSideEffect(state, effectId);
    if (effect?.status === "completed" || isImplementationDispatchDurable(state, effectId)) {
      return {
        outcome: "subject_already_complete",
        reviewRequestId: effect?.reviewRequestId ?? reviewRequestId,
        state,
        httpDispatched: false,
      };
    }
  }

  if (isImplementationDispatchDurable(state, effectId)) {
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
    (existingEffect?.dispatchAttemptCount ?? 0) >=
      IMPLEMENTATION_DISPATCH_MAX_ATTEMPTS &&
    existingEffect?.status === "blocked"
  ) {
    return {
      outcome: "max_attempts_exhausted",
      reviewRequestId: existingEffect.reviewRequestId ?? reviewRequestId,
      state,
      httpDispatched: false,
    };
  }

  // Active builder or lease for this subject — observe, do not re-dispatch.
  const leaseIdentity = `implementation:${input.implementationSubjectIdentity}`;
  if (
    state.builderAgentId ||
    (state.activeRunLease?.identity === leaseIdentity &&
      state.activeRunLease.expiresAt &&
      Date.parse(state.activeRunLease.expiresAt) > Date.now())
  ) {
    return {
      outcome: "already_dispatched",
      reviewRequestId,
      state,
      httpDispatched: false,
    };
  }

  state = await ensureImplementationDispatchPending({
    store: input.store,
    issueKey: input.issueKey,
    implementationSubjectIdentity: input.implementationSubjectIdentity,
    state,
  });

  const claimed = claimImplementationDispatchEffect(state, {
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
    if (isImplementationDispatchDurable(reloaded, effectId)) {
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
    const marked = markImplementationDispatchDispatched(state, {
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
    const blocked = markImplementationDispatchBlocked(state, {
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

  const attempts =
    (getSideEffect(state, effectId)?.dispatchAttemptCount ?? 0) + 1;
  if (attempts > IMPLEMENTATION_DISPATCH_MAX_ATTEMPTS) {
    const blocked = markImplementationDispatchBlocked(state, {
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

  const result = await createImplementationJobAndDispatch({
    issueKey: input.issueKey,
    implementationSubjectIdentity: input.implementationSubjectIdentity,
    env,
    fetchImpl: input.fetchImpl,
    dispatchToken: token,
  });

  const marked = markImplementationDispatchDispatched(state, {
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
        const repaired = markImplementationDispatchDispatched(reloaded, {
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
