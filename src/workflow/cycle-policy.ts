/**
 * Generic cycle-limit policy. Counters mutate only via atomic WorkflowStateRecord apply.
 */

export type CycleIncrementClassification =
  | "review_revision"
  | "infra_retry"
  | "duplicate"
  | "stale";

export interface CyclePolicyInput {
  counterId: string;
  currentCount: number;
  maximum: number;
  classification: CycleIncrementClassification;
}

export interface CyclePolicyResult {
  shouldIncrement: boolean;
  nextCount: number;
  limitReached: boolean;
  reason: string;
}

export function evaluateCycleIncrement(
  input: CyclePolicyInput,
): CyclePolicyResult {
  if (input.classification !== "review_revision") {
    return {
      shouldIncrement: false,
      nextCount: input.currentCount,
      limitReached: input.currentCount >= input.maximum,
      reason: `ignored_${input.classification}`,
    };
  }

  const nextCount = input.currentCount + 1;
  const limitReached = nextCount > input.maximum;
  return {
    shouldIncrement: !limitReached,
    nextCount: limitReached ? input.currentCount : nextCount,
    limitReached,
    reason: limitReached ? "cycle_limit_reached" : "review_revision_increment",
  };
}

export function isCycleLimitExceeded(
  currentCount: number,
  maximum: number,
): boolean {
  return currentCount >= maximum;
}
