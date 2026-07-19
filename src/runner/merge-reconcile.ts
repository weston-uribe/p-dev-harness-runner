import type { HarnessConfig } from "../config/types.js";
import { getTransitionalStatus } from "../config/status-names.js";
import type { LinearIssueSnapshot } from "../linear/client.js";
import { findLatestMergeSourceComment } from "../linear/merge-source-comment.js";
import type { LinearCommentRecord } from "../linear/writer.js";
import { checkMergeIdempotency } from "./idempotency.js";

export type MergeReconcileTrigger = "issue_status" | "cli" | "schedule";

export type MergeReconcileAction =
  | "dispatch_merge"
  | "skip_duplicate"
  | "ignore";

export interface MergeReconcilePullRequestSnapshot {
  url: string;
  state: string;
  merged: boolean;
  baseBranch: string;
}

export interface MergeReconcileInput {
  config: HarnessConfig;
  issue: LinearIssueSnapshot;
  comments: LinearCommentRecord[];
  trigger: MergeReconcileTrigger;
  /** Development base branch from route resolution (e.g. dev). */
  expectedBaseBranch?: string | null;
  /** Optional live PR snapshot when GitHub is available. */
  pullRequest?: MergeReconcilePullRequestSnapshot | null;
  force?: boolean;
}

export interface MergeReconcileResult {
  action: MergeReconcileAction;
  prUrl: string | null;
  reason: string;
}

/**
 * Shared merge eligibility used by webhooks, resolve-route, CLI, and schedule.
 * Generation identity is issueKey + prUrl (merge marker keyed by PR URL).
 */
export function evaluateMergeReconcile(
  input: MergeReconcileInput,
): MergeReconcileResult {
  const readyToMerge = getTransitionalStatus(input.config, "readyToMerge");
  const merging = getTransitionalStatus(input.config, "mergingInProgress");
  const status = input.issue.status?.trim() ?? "";
  const statusLower = status.toLowerCase();

  const mergeSource = findLatestMergeSourceComment(
    input.comments,
    input.config.orchestratorMarker,
  );
  if (!mergeSource) {
    return {
      action: "ignore",
      prUrl: null,
      reason: "missing_merge_source_marker",
    };
  }

  const prUrl = mergeSource.markers.prUrl?.trim() ?? "";
  if (!prUrl) {
    return {
      action: "ignore",
      prUrl: null,
      reason: "missing_pr_url",
    };
  }

  const idempotency = checkMergeIdempotency(
    input.config,
    input.issue,
    input.comments,
    prUrl,
    Boolean(input.pullRequest?.merged),
    Boolean(input.force),
  );

  if (idempotency.skip) {
    return {
      action: "skip_duplicate",
      prUrl,
      reason: idempotency.reason ?? "duplicate_phase_completed",
    };
  }

  const statusOk =
    statusLower === readyToMerge.toLowerCase() ||
    (Boolean(input.force) && statusLower === merging.toLowerCase());

  if (!statusOk) {
    return {
      action: "ignore",
      prUrl,
      reason:
        idempotency.reason?.startsWith("wrong_status")
          ? idempotency.reason
          : `wrong_status: issue is "${status || "unknown"}"; expected ${readyToMerge}`,
    };
  }

  if (input.pullRequest) {
    const liveUrl = input.pullRequest.url.trim();
    if (liveUrl && liveUrl !== prUrl) {
      return {
        action: "ignore",
        prUrl,
        reason: "pr_url_mismatch: live PR does not match merge-source marker",
      };
    }

    if (input.pullRequest.merged) {
      // Let idempotency decide recovery vs skip for already-merged PRs.
    } else if (input.pullRequest.state.toLowerCase() !== "open") {
      return {
        action: "ignore",
        prUrl,
        reason: `pr_not_open: PR state is "${input.pullRequest.state}"`,
      };
    }

    const expectedBase = input.expectedBaseBranch?.trim();
    if (
      expectedBase &&
      input.pullRequest.baseBranch.trim().toLowerCase() !==
        expectedBase.toLowerCase()
    ) {
      return {
        action: "ignore",
        prUrl,
        reason: `pr_base_mismatch: expected base "${expectedBase}", got "${input.pullRequest.baseBranch}"`,
      };
    }
  }

  return {
    action: "dispatch_merge",
    prUrl,
    reason: idempotency.reason?.startsWith("recovery:")
      ? idempotency.reason
      : "eligible_merge",
  };
}
