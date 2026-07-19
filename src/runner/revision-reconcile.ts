import type { HarnessConfig } from "../config/types.js";
import { getTransitionalStatus } from "../config/status-names.js";
import type { LinearIssueSnapshot } from "../linear/client.js";
import { findLatestHandoffComment } from "../linear/handoff-comment.js";
import { isHarnessOrchestratorComment } from "../linear/comments.js";
import { findLatestPmFeedbackAfterHandoff } from "../linear/pm-feedback-comment.js";
import type { LinearCommentRecord } from "../linear/writer.js";
import { checkRevisionIdempotency } from "./idempotency.js";

export type RevisionReconcileTrigger =
  | "issue_status"
  | "comment_create"
  | "cli"
  | "schedule";

export type RevisionReconcileAction =
  | "dispatch_revision"
  | "record_pending"
  | "skip_duplicate"
  | "ignore";

export interface RevisionReconcileInput {
  config: HarnessConfig;
  issue: LinearIssueSnapshot;
  comments: LinearCommentRecord[];
  trigger: RevisionReconcileTrigger;
  /** Comment id from a Comment webhook; optional for status/cli/schedule. */
  commentId?: string | null;
  /** Comment body from a Comment webhook; used to exclude harness noise. */
  commentBody?: string | null;
  force?: boolean;
}

export interface RevisionReconcileResult {
  action: RevisionReconcileAction;
  pmFeedbackCommentId: string | null;
  reason: string;
}

/**
 * Shared revision eligibility used by webhooks, resolve-route, CLI, and schedule.
 * Generation identity is the PM feedback comment id (not issue+phase alone).
 */
export function evaluateRevisionReconcile(
  input: RevisionReconcileInput,
): RevisionReconcileResult {
  const needsRevision = getTransitionalStatus(input.config, "needsRevision");
  const status = input.issue.status?.trim() ?? "";

  if (status.toLowerCase() !== needsRevision.toLowerCase()) {
    return {
      action: "ignore",
      pmFeedbackCommentId: null,
      reason: `wrong_status: issue is "${status || "unknown"}"; expected ${needsRevision}`,
    };
  }

  if (input.trigger === "comment_create") {
    const body = input.commentBody?.trim() ?? "";
    if (!body) {
      return {
        action: "ignore",
        pmFeedbackCommentId: null,
        reason: "ignored_comment: empty body",
      };
    }
    if (isHarnessOrchestratorComment(body, input.config.orchestratorMarker)) {
      return {
        action: "ignore",
        pmFeedbackCommentId: null,
        reason: "ignored_comment: harness orchestrator comment",
      };
    }
  }

  const handoffComment = findLatestHandoffComment(
    input.comments,
    input.config.orchestratorMarker,
  );
  if (!handoffComment) {
    return {
      action: "ignore",
      pmFeedbackCommentId: null,
      reason: "missing_handoff_marker",
    };
  }

  const pmFeedback = findLatestPmFeedbackAfterHandoff(
    input.comments,
    handoffComment,
    input.config.orchestratorMarker,
  );

  if (!pmFeedback) {
    return {
      action: "record_pending",
      pmFeedbackCommentId: null,
      reason: "pending_pm_feedback",
    };
  }

  if (
    input.trigger === "comment_create" &&
    input.commentId &&
    input.commentId !== pmFeedback.id
  ) {
    // Older or non-latest feedback comments should not start a new generation.
    return {
      action: "ignore",
      pmFeedbackCommentId: pmFeedback.id,
      reason: "ignored_comment: not latest eligible PM feedback",
    };
  }

  const idempotency = checkRevisionIdempotency(
    input.config,
    input.issue,
    input.comments,
    pmFeedback.id,
    Boolean(input.force),
  );

  if (idempotency.skip) {
    return {
      action: "skip_duplicate",
      pmFeedbackCommentId: pmFeedback.id,
      reason: idempotency.reason ?? "duplicate_phase_completed",
    };
  }

  if (idempotency.reason?.startsWith("wrong_status")) {
    return {
      action: "ignore",
      pmFeedbackCommentId: pmFeedback.id,
      reason: idempotency.reason,
    };
  }

  return {
    action: "dispatch_revision",
    pmFeedbackCommentId: pmFeedback.id,
    reason: "eligible_revision",
  };
}

/** Stable numeric generation for run-status upserts keyed by feedback id. */
export function revisionGenerationFromPmFeedback(
  pmFeedbackCommentId: string,
): number {
  let hash = 0;
  for (let i = 0; i < pmFeedbackCommentId.length; i += 1) {
    hash = (hash * 31 + pmFeedbackCommentId.charCodeAt(i)) >>> 0;
  }
  // Keep away from tiny timestamp generations used by receive-ack comments.
  return 1_000_000_000 + (hash % 1_000_000_000);
}
