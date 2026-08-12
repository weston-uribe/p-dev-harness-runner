export type WorkflowInstallLifecycle =
  | "preparing"
  | "pr-created"
  | "pr-updated"
  | "waiting-for-checks"
  | "updating-branch"
  | "merging"
  | "verifying"
  | "complete"
  | "blocked";

export type WorkflowInstallUiPhase =
  | "preparing-workflow-installation"
  | "creating-or-refreshing-install-branch"
  | "verifying-install-pull-request"
  | "waiting-for-github-checks"
  | "merging-workflow-installation"
  | "verifying-production-workflow";

export type WorkflowInstallBlockedCategory =
  | "checks-pending"
  | "checks-failing"
  | "mergeability-pending"
  | "branch-behind"
  | "review-required"
  | "permission-denied"
  | "merge-conflict"
  | "unexpected-pr-content"
  | "merge-queue-required"
  | "merge-api-failure"
  | "verification-failed"
  | "transient-github-unavailable";

export type WorkflowInstallErrorCode =
  | "none"
  | "lock_contended"
  | "transient_network"
  | "transient_github_5xx"
  | "mergeability_pending"
  | "checks_pending"
  | "branch_behind"
  | "unexpected_pr_content"
  | "merge_conflict"
  | "permission_denied"
  | "verification_failed"
  | "merge_api_failure"
  | "retry_budget_exhausted"
  | "unknown";

export interface TargetWorkflowFinalizationResult {
  repoConfigId: string;
  targetRepo: string;
  targetRepoSlug: string;
  productionBranch: string;
  branchName: string;
  lifecycle: WorkflowInstallLifecycle;
  phase: WorkflowInstallUiPhase;
  operationId: string;
  blockedCategory?: WorkflowInstallBlockedCategory;
  message: string;
  prUrl?: string;
  prNumber?: number;
  supersededPrNumber?: number;
  validatedHeadSha?: string;
  workflowStatus:
    | "present"
    | "missing"
    | "differs"
    | "stale_dispatch_target"
    | "contract_outdated"
    | "unknown";
  canRetry: boolean;
  /** Server-authoritative: client must not infer retryability from message text. */
  retryable: boolean;
  retryAfterMs?: number;
  lastSafeCheckpoint?: string;
  errorCode: WorkflowInstallErrorCode;
  requiresGitHubIntervention: boolean;
  advancedThisRequest: boolean;
  lockContended: boolean;
  updatedAt: string;
}

export interface TargetWorkflowFinalizeInput {
  repoConfigId: string;
  targetRepo: string;
  productionBranch: string;
  manualHarnessDispatchRepo?: string;
  prUrl?: string;
  branchName?: string;
  operationId?: string;
}

export const WORKFLOW_INSTALL_CHECK_POLL_TIMEOUT_MS = 120_000;
export const WORKFLOW_INSTALL_VERIFICATION_TIMEOUT_MS = 60_000;
export const WORKFLOW_INSTALL_SHORT_POLL_INTERVAL_MS = 2_000;
export const WORKFLOW_INSTALL_MAX_TRANSIENT_RETRIES = 8;
export const WORKFLOW_INSTALL_BASE_RETRY_MS = 2_000;
export const WORKFLOW_INSTALL_MAX_RETRY_MS = 30_000;

export const WORKFLOW_INSTALL_UI_PHASES: readonly WorkflowInstallUiPhase[] = [
  "preparing-workflow-installation",
  "creating-or-refreshing-install-branch",
  "verifying-install-pull-request",
  "waiting-for-github-checks",
  "merging-workflow-installation",
  "verifying-production-workflow",
] as const;

export const WORKFLOW_INSTALL_UI_PHASE_LABELS: Record<
  WorkflowInstallUiPhase,
  string
> = {
  "preparing-workflow-installation": "Preparing workflow installation",
  "creating-or-refreshing-install-branch":
    "Creating or refreshing install branch",
  "verifying-install-pull-request": "Verifying install pull request",
  "waiting-for-github-checks": "Waiting for GitHub checks",
  "merging-workflow-installation": "Merging workflow installation",
  "verifying-production-workflow": "Verifying production workflow",
};

export function lifecycleToUiPhase(
  lifecycle: WorkflowInstallLifecycle,
): WorkflowInstallUiPhase {
  switch (lifecycle) {
    case "preparing":
    case "pr-created":
    case "pr-updated":
      return "preparing-workflow-installation";
    case "updating-branch":
      return "creating-or-refreshing-install-branch";
    case "waiting-for-checks":
      return "waiting-for-github-checks";
    case "merging":
      return "merging-workflow-installation";
    case "verifying":
    case "complete":
      return "verifying-production-workflow";
    case "blocked":
      return "verifying-install-pull-request";
    default:
      return "preparing-workflow-installation";
  }
}

export function errorCodeForBlockedCategory(
  category: WorkflowInstallBlockedCategory | undefined,
): WorkflowInstallErrorCode {
  switch (category) {
    case "checks-pending":
      return "checks_pending";
    case "mergeability-pending":
      return "mergeability_pending";
    case "branch-behind":
      return "branch_behind";
    case "unexpected-pr-content":
      return "unexpected_pr_content";
    case "merge-conflict":
      return "merge_conflict";
    case "permission-denied":
      return "permission_denied";
    case "verification-failed":
      return "verification_failed";
    case "merge-api-failure":
    case "merge-queue-required":
      return "merge_api_failure";
    case "transient-github-unavailable":
      return "transient_github_5xx";
    case "checks-failing":
    case "review-required":
      return "unexpected_pr_content";
    default:
      return "unknown";
  }
}

export function isRetryableBlockedCategory(
  category: WorkflowInstallBlockedCategory | undefined,
): boolean {
  return (
    category === "checks-pending" ||
    category === "mergeability-pending" ||
    category === "branch-behind" ||
    category === "verification-failed" ||
    category === "transient-github-unavailable"
  );
}
