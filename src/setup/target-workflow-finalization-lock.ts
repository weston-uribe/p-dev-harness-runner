import type { TargetWorkflowFinalizationResult } from "./target-workflow-finalization-types.js";

const activeLocks = new Set<string>();
const latestResults = new Map<string, TargetWorkflowFinalizationResult>();

export function buildFinalizationLockKey(
  targetRepoSlug: string,
  repoConfigId: string,
): string {
  return `${targetRepoSlug}:${repoConfigId}`;
}

export function isFinalizationLockActive(key: string): boolean {
  return activeLocks.has(key);
}

export function getCachedFinalizationResult(
  key: string,
): TargetWorkflowFinalizationResult | undefined {
  return latestResults.get(key);
}

export function setCachedFinalizationResult(
  key: string,
  result: TargetWorkflowFinalizationResult,
): void {
  latestResults.set(key, result);
}

export function clearCachedFinalizationResult(key: string): void {
  latestResults.delete(key);
}

/**
 * Serializes finalization for one target repo config. Concurrent callers wait for
 * the in-flight advancement, then receive the latest cached result without
 * issuing duplicate mutations.
 */
export async function withTargetWorkflowFinalizationLock<T>(
  key: string,
  fn: () => Promise<T>,
): Promise<{ result: T; lockContended: boolean }> {
  if (activeLocks.has(key)) {
    const cached = latestResults.get(key);
    if (cached) {
      return { result: cached as unknown as T, lockContended: true };
    }
    await waitForLockRelease(key);
    const afterWait = latestResults.get(key);
    if (afterWait) {
      return { result: afterWait as unknown as T, lockContended: true };
    }
  }

  activeLocks.add(key);
  try {
    const result = await fn();
    if (
      typeof result === "object" &&
      result !== null &&
      "lifecycle" in result
    ) {
      const finalization = result as unknown as TargetWorkflowFinalizationResult;
      latestResults.set(key, finalization);
      if (finalization.lifecycle === "complete") {
        latestResults.delete(key);
      }
    }
    return { result, lockContended: false };
  } finally {
    activeLocks.delete(key);
    notifyLockReleased(key);
  }
}

const lockWaiters = new Map<string, Array<() => void>>();

function waitForLockRelease(key: string): Promise<void> {
  if (!activeLocks.has(key)) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const waiters = lockWaiters.get(key) ?? [];
    waiters.push(resolve);
    lockWaiters.set(key, waiters);
  });
}

export function notifyLockReleased(key: string): void {
  const waiters = lockWaiters.get(key) ?? [];
  lockWaiters.delete(key);
  for (const resolve of waiters) {
    resolve();
  }
}
