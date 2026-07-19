export interface WorkflowInstallMergeGateInput {
  mergeableState: string | null;
  mergeable: boolean | null;
}

/**
 * Whether workflow-install finalization should call the GitHub merge API after
 * harness safety checks pass. Branch-behind handling stays upstream.
 */
export function shouldAttemptMerge(input: WorkflowInstallMergeGateInput): boolean {
  const state = input.mergeableState?.toLowerCase() ?? null;
  if (input.mergeable === false) {
    return false;
  }
  if (state === "dirty") {
    return false;
  }
  if (input.mergeable === null || state === "unknown") {
    return false;
  }
  if (state === "behind") {
    return false;
  }
  return true;
}
