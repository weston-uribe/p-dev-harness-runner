export const DEFAULT_WORKFLOW_STATE_MAX_RETRIES = 3;

export type WorkflowStateConflictReason =
  | "stale_state"
  | "conflict_exhausted"
  | "evidence_mismatch"
  | "illegal_transition"
  | "duplicate_transition"
  | "superseded_generation"
  | "active_run_conflict";

export interface RetryDecision {
  retry: boolean;
  reason: WorkflowStateConflictReason;
  attempt: number;
}

/**
 * Bounded conflict detection / reread-retry protocol when CAS fails.
 */
export function decideConflictRetry(input: {
  attempt: number;
  maxRetries?: number;
  casFailed: boolean;
}): RetryDecision {
  const maxRetries = input.maxRetries ?? DEFAULT_WORKFLOW_STATE_MAX_RETRIES;
  if (!input.casFailed) {
    return { retry: false, reason: "stale_state", attempt: input.attempt };
  }
  if (input.attempt >= maxRetries) {
    return {
      retry: false,
      reason: "conflict_exhausted",
      attempt: input.attempt,
    };
  }
  return { retry: true, reason: "stale_state", attempt: input.attempt };
}
