import type { RunnerUpgradeStatusResult } from "@harness/setup/runner-upgrade-types";

export function runnerUpgradeHasLiveCurrentIdentity(
  status: RunnerUpgradeStatusResult | null | undefined,
): boolean {
  return Boolean(status?.currentSnapshot && status.currentSnapshotCached !== true);
}

export function runnerUpgradeCanPreview(input: {
  status: RunnerUpgradeStatusResult | null | undefined;
  tokenUnavailable: boolean;
  lifecycleBusy: boolean;
}): boolean {
  if (input.tokenUnavailable || input.lifecycleBusy) {
    return false;
  }
  if (
    input.status?.status === "blocked_non_managed" ||
    input.status?.status === "blocked_operator_conflicts" ||
    input.status?.status === "blocked_unexpected_remote"
  ) {
    return false;
  }
  return (
    runnerUpgradeHasLiveCurrentIdentity(input.status) &&
    (input.status?.status === "update_available" ||
      input.status?.status === "partially_updated" ||
      input.status?.status === "failed")
  );
}

export function runnerUpgradeCanApply(input: {
  status: RunnerUpgradeStatusResult | null | undefined;
  tokenUnavailable: boolean;
  lifecycleBusy: boolean;
}): boolean {
  if (input.tokenUnavailable || input.lifecycleBusy) {
    return false;
  }
  if (
    input.status?.status === "blocked_non_managed" ||
    input.status?.status === "blocked_operator_conflicts" ||
    input.status?.status === "blocked_unexpected_remote"
  ) {
    return false;
  }
  if (
    input.status?.status === "update_available" ||
    input.status?.status === "partially_updated" ||
    input.status?.status === "failed"
  ) {
    return true;
  }
  // Checking: allow Update when local managed-repo evidence exists.
  // Cached identity alone is never enough; worker still verifies authoritatively.
  return (
    input.status?.status === "checking" &&
    input.status.localManagedRepoEvidence === true
  );
}

export function runnerUpgradeRetryStatusVisible(
  status: RunnerUpgradeStatusResult | null | undefined,
): boolean {
  return (
    status?.retryAvailable === true ||
    status?.status === "checking" ||
    status?.degraded === true
  );
}

export function formatRunnerUpgradeCurrentSnapshotLine(
  status: RunnerUpgradeStatusResult | null | undefined,
): string {
  const snapshot = status?.currentSnapshot;
  if (!snapshot) {
    return "Current runner: —";
  }
  const version = snapshot.packageVersion;
  if (status?.currentSnapshotCached) {
    const verifiedAt = status.currentSnapshotVerifiedAt
      ? new Date(status.currentSnapshotVerifiedAt).toLocaleString()
      : "unknown time";
    return `Current runner: ${version} — last verified ${verifiedAt} (cached until refreshed)`;
  }
  return `Current runner: ${version} (${snapshot.snapshotContentId.slice(0, 12)}…)`;
}
