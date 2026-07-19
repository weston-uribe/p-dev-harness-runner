export const RUNNER_UPGRADE_CANARY_WORKFLOW_PATH =
  ".github/workflows/p-dev-runner-config-canary.yml";

export type RunnerUpgradePhase =
  | "verifying-managed-repository"
  | "comparing-runner-snapshots"
  | "preparing-upgrade-commit"
  | "updating-managed-runner"
  | "verifying-runner-on-production-branch"
  | "synchronizing-cloud-configuration"
  | "running-configuration-canary";

export type RunnerUpgradeUiPhase = RunnerUpgradePhase;

export type RunnerUpgradeStatus =
  | "up_to_date"
  | "update_available"
  | "checking"
  | "updating"
  | "partially_updated"
  | "failed"
  | "blocked_non_managed"
  | "blocked_unexpected_remote"
  | "blocked_operator_conflicts";

const RUNNER_UPGRADE_PR_MARKER_PATTERN =
  /<!--\s*p-dev-runner-upgrade:(\d+):([^\s>]+)\s*-->/;

export function buildRunnerUpgradePrMarker(
  repositoryId: number,
  snapshotContentId: string,
): string {
  return `<!-- p-dev-runner-upgrade:${repositoryId}:${snapshotContentId} -->`;
}

export function parseRunnerUpgradePrMarker(body: string): {
  repositoryId: number;
  snapshotContentId: string;
} | null {
  const match = body.match(RUNNER_UPGRADE_PR_MARKER_PATTERN);
  if (!match) {
    return null;
  }
  const repositoryId = Number(match[1]);
  if (!Number.isInteger(repositoryId) || repositoryId <= 0) {
    return null;
  }
  const snapshotContentId = match[2]?.trim();
  if (!snapshotContentId) {
    return null;
  }
  return { repositoryId, snapshotContentId };
}

export function buildRunnerUpgradeBranchName(snapshotContentId: string): string {
  return `harness/update-runner-${snapshotContentId.slice(0, 12)}`;
}

export function runnerUpgradePhaseLabel(phase: RunnerUpgradePhase): string {
  switch (phase) {
    case "verifying-managed-repository":
      return "Verifying managed repository";
    case "comparing-runner-snapshots":
      return "Comparing runner snapshots";
    case "preparing-upgrade-commit":
      return "Preparing upgrade commit";
    case "updating-managed-runner":
      return "Updating managed runner";
    case "verifying-runner-on-production-branch":
      return "Verifying runner on production branch";
    case "synchronizing-cloud-configuration":
      return "Synchronizing cloud configuration";
    case "running-configuration-canary":
      return "Running configuration canary";
  }
}

export function runnerUpgradeStatusLabel(status: RunnerUpgradeStatus): string {
  switch (status) {
    case "up_to_date":
      return "Up to date";
    case "update_available":
      return "Update available";
    case "checking":
      return "Checking runner version";
    case "updating":
      return "Updating";
    case "partially_updated":
      return "Partially updated";
    case "failed":
      return "Failed";
    case "blocked_non_managed":
      return "Blocked — repository is not managed";
    case "blocked_unexpected_remote":
      return "Blocked — unexpected remote changes";
    case "blocked_operator_conflicts":
      return "Blocked — operator conflicts";
  }
}

export interface RunnerUpgradeSnapshotSummary {
  snapshotContentId: string;
  packageVersion: string;
  sourceCommit: string;
}

export interface RunnerUpgradeImpactSummary {
  replacePathCount: number;
  deletePathCount: number;
  sampleReplacePaths: string[];
  sampleDeletePaths: string[];
}

export interface RunnerUpgradeStatusResult {
  status: RunnerUpgradeStatus;
  statusLabel: string;
  currentSnapshot?: RunnerUpgradeSnapshotSummary;
  availableSnapshot?: RunnerUpgradeSnapshotSummary;
  pendingOperationId?: string;
  pendingPhase?: RunnerUpgradePhase;
  conflictPaths?: string[];
  blockedReason?: string;
  canaryRunUrl?: string;
  prUrl?: string;
  retryGuidance?: string;
  degraded?: boolean;
  /** True when local managed-repo marker/evidence exists (not remote-verified). */
  localManagedRepoEvidence?: boolean;
  /** True when currentSnapshot comes from last-verified cache, not this request. */
  currentSnapshotCached?: boolean;
  /** ISO timestamp when cached/live current identity was last verified remotely. */
  currentSnapshotVerifiedAt?: string;
  /** Last status pipeline stage that had not completed when the request timed out. */
  unresolvedStage?: string;
  /** Present when debug timings are enabled (env or query flag). */
  debugTimings?: Array<{
    stage: string;
    durationMs: number;
    timedOut?: boolean;
  }>;
  /** Client/UI hint: Retry status control should be shown. */
  retryAvailable?: boolean;
}

export interface RunnerUpgradeAcceptResult {
  operationId: string;
  status: "updating";
  phase: RunnerUpgradePhase;
  previewFingerprint: string;
  message: string;
}

export interface RunnerUpgradePreviewResult {
  previewFingerprint: string;
  targetSnapshotContentId: string;
  currentSnapshotContentId?: string;
  impact: RunnerUpgradeImpactSummary;
  phases: RunnerUpgradePhase[];
  blocked?: boolean;
  blockedStatus?: RunnerUpgradeStatus;
  conflictPaths?: string[];
  message?: string;
}

export interface RunnerUpgradeApplyResult {
  operationId: string;
  status: RunnerUpgradeStatus;
  phase: RunnerUpgradePhase;
  previewFingerprint: string;
  prUrl?: string;
  prNumber?: number;
  branchName?: string;
  canaryRunId?: string;
  canaryRunUrl?: string;
  message?: string;
}
