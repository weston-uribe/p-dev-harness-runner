import { describe, expect, it } from "vitest";
import {
  blockedCategoryMessage,
  classifyWorkflowInstallMergeRejection,
} from "../../src/setup/workflow-install-merge-errors.js";
import { GitHubApiError } from "../../src/github/client.js";

describe("workflow-install-merge-errors", () => {
  it("classifies permission denial", () => {
    const result = classifyWorkflowInstallMergeRejection({
      error: new GitHubApiError(403, "Resource not accessible by integration"),
    });
    expect(result.category).toBe("permission-denied");
    expect(result.waiting).toBe(false);
  });

  it("does not classify blocked merge state alone as review-required", () => {
    const result = classifyWorkflowInstallMergeRejection({
      error: new GitHubApiError(422, "Repository rule violations found"),
      mergeableState: "blocked",
    });
    expect(result.category).not.toBe("review-required");
    expect(result.category).toBe("merge-api-failure");
  });

  it("classifies explicit review requirement from API wording", () => {
    const result = classifyWorkflowInstallMergeRejection({
      error: new GitHubApiError(
        422,
        "Pull request is not mergeable: approving review is required",
      ),
    });
    expect(result.category).toBe("review-required");
    expect(result.waiting).toBe(false);
  });

  it("prefers structured check policy over loose API message for checks", () => {
    const result = classifyWorkflowInstallMergeRejection({
      error: new GitHubApiError(422, "Required status check is pending"),
      checkPolicy: {
        decision: "allow",
        classification: null,
        reason: "Pending checks present; proceeding per allowPendingChecks",
        warnings: [],
      },
    });
    expect(result.category).not.toBe("checks-pending");
    expect(result.category).toBe("merge-api-failure");
  });

  it("classifies failing checks from structured check policy", () => {
    const result = classifyWorkflowInstallMergeRejection({
      error: new GitHubApiError(422, "Merge blocked"),
      checkPolicy: {
        decision: "block",
        classification: "checks_failing",
        reason: "Failing checks: ci",
        warnings: [],
      },
    });
    expect(result.category).toBe("checks-failing");
    expect(result.waiting).toBe(false);
  });

  it("classifies pending checks from structured check policy", () => {
    const result = classifyWorkflowInstallMergeRejection({
      error: new GitHubApiError(422, "Merge blocked"),
      checkPolicy: {
        decision: "block",
        classification: "checks_unknown",
        reason: "No GitHub check runs reported for the PR head commit",
        warnings: [],
      },
    });
    expect(result.category).toBe("checks-pending");
    expect(result.waiting).toBe(true);
  });

  it("classifies deployment requirement as merge-api-failure", () => {
    const result = classifyWorkflowInstallMergeRejection({
      error: new GitHubApiError(
        422,
        "Required deployment environment protection rules are not satisfied",
      ),
    });
    expect(result.category).toBe("merge-api-failure");
    expect(result.message).toContain("deployment");
  });

  it("classifies merge conflict", () => {
    const result = classifyWorkflowInstallMergeRejection({
      error: new GitHubApiError(409, "Head branch was modified"),
      mergeableState: "dirty",
    });
    expect(result.category).toBe("merge-conflict");
  });

  it("exposes PM-readable blocked messages without secrets", () => {
    const message = blockedCategoryMessage("unexpected-pr-content");
    expect(message).toContain("unexpected");
    expect(message).not.toMatch(/ghp_|Bearer /);
  });
});
