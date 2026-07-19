import { GitHubApiError } from "../github/client.js";
import type { CheckPolicyResult } from "../github/check-policy.js";
import { classifyMergeError } from "../github/merge-result.js";
import type { WorkflowInstallBlockedCategory } from "./target-workflow-finalization-types.js";

export interface ClassifyWorkflowInstallMergeRejectionInput {
  error: unknown;
  mergeableState?: string | null;
  message?: string;
  checkPolicy?: CheckPolicyResult;
}

export function classifyWorkflowInstallMergeRejection(
  input: ClassifyWorkflowInstallMergeRejectionInput,
): {
  category: WorkflowInstallBlockedCategory;
  waiting: boolean;
  message: string;
} {
  const apiMessage = (
    input.message ??
    (input.error instanceof Error ? input.error.message : String(input.error))
  ).toLowerCase();

  if (input.checkPolicy?.decision === "block") {
    if (input.checkPolicy.classification === "checks_failing") {
      return {
        category: "checks-failing",
        waiting: false,
        message: input.checkPolicy.reason,
      };
    }
    return {
      category: "checks-pending",
      waiting: true,
      message: input.checkPolicy.reason,
    };
  }

  if (input.error instanceof GitHubApiError) {
    if (input.error.status === 401 || input.error.status === 403) {
      if (
        apiMessage.includes("review") ||
        apiMessage.includes("approval") ||
        apiMessage.includes("required reviewers")
      ) {
        return {
          category: "review-required",
          waiting: false,
          message:
            "GitHub requires human review before this workflow install PR can merge.",
        };
      }
      if (
        apiMessage.includes("bypass") ||
        apiMessage.includes("not permitted") ||
        apiMessage.includes("insufficient")
      ) {
        return {
          category: "permission-denied",
          waiting: false,
          message:
            "The setup token cannot bypass repository rules to merge this workflow install PR.",
        };
      }
      return {
        category: "permission-denied",
        waiting: false,
        message:
          "The setup token does not have permission to merge this workflow install PR.",
      };
    }

    if (input.error.status === 405) {
      if (classifyMergeError(input.error) === "pr_already_merged") {
        return {
          category: "merge-api-failure",
          waiting: false,
          message: "Workflow install PR was already merged.",
        };
      }
    }

    if (input.error.status === 409) {
      return {
        category: "merge-conflict",
        waiting: false,
        message:
          "The workflow install PR has merge conflicts that require manual resolution.",
      };
    }

    if (input.error.status === 422) {
      if (
        apiMessage.includes("merge queue") ||
        apiMessage.includes("queued for merge")
      ) {
        return {
          category: "merge-queue-required",
          waiting: false,
          message:
            "This repository requires merge queue handling that onboarding does not support automatically.",
        };
      }
      if (
        apiMessage.includes("head sha") ||
        apiMessage.includes("expected head")
      ) {
        return {
          category: "mergeability-pending",
          waiting: true,
          message:
            "The workflow install PR head changed during finalization. Revalidating before merge.",
        };
      }
      if (
        apiMessage.includes("review") ||
        apiMessage.includes("approval") ||
        apiMessage.includes("required reviewers")
      ) {
        return {
          category: "review-required",
          waiting: false,
          message:
            "GitHub requires human review before this workflow install PR can merge.",
        };
      }
      if (
        apiMessage.includes("bypass") ||
        apiMessage.includes("not permitted") ||
        apiMessage.includes("insufficient")
      ) {
        return {
          category: "permission-denied",
          waiting: false,
          message:
            "The setup token cannot bypass repository rules to merge this workflow install PR.",
        };
      }
      if (
        apiMessage.includes("conversation") ||
        apiMessage.includes("thread resolution") ||
        apiMessage.includes("unresolved")
      ) {
        return {
          category: "merge-api-failure",
          waiting: false,
          message:
            "GitHub requires unresolved review conversations to be resolved before merge.",
        };
      }
      if (apiMessage.includes("deployment")) {
        return {
          category: "merge-api-failure",
          waiting: false,
          message:
            "GitHub requires a deployment requirement before this workflow install PR can merge.",
        };
      }
    }
  }

  const state = input.mergeableState?.toLowerCase() ?? "";
  if (state === "dirty") {
    return {
      category: "merge-conflict",
      waiting: false,
      message:
        "The workflow install PR has merge conflicts that require manual resolution.",
    };
  }
  if (state === "behind") {
    return {
      category: "branch-behind",
      waiting: true,
      message: "The workflow install branch is behind the production branch.",
    };
  }

  return {
    category: "merge-api-failure",
    waiting: false,
    message: "GitHub rejected the workflow install PR merge request.",
  };
}

export function blockedCategoryMessage(
  category: WorkflowInstallBlockedCategory,
): string {
  switch (category) {
    case "checks-pending":
      return "Waiting for GitHub checks on the workflow install PR.";
    case "checks-failing":
      return "Required checks failed on the workflow install PR.";
    case "mergeability-pending":
      return "GitHub is still computing mergeability for the workflow install PR.";
    case "branch-behind":
      return "Refreshing the workflow install branch…";
    case "review-required":
      return "Human review is required before the workflow install PR can merge.";
    case "permission-denied":
      return "The setup token cannot merge the workflow install PR.";
    case "merge-conflict":
      return "The workflow install PR has merge conflicts.";
    case "unexpected-pr-content":
      return "The workflow install PR contains unexpected changes.";
    case "merge-queue-required":
      return "This repository requires merge queue handling.";
    case "merge-api-failure":
      return "GitHub rejected the workflow install merge request.";
    case "verification-failed":
      return "The workflow was merged but production verification has not succeeded yet.";
    default:
      return "Workflow install finalization is blocked.";
  }
}
