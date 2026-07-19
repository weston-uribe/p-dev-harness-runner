import { GitHubApiError } from "./client.js";

export interface GitHubMergeResponse {
  sha: string;
  merged: boolean;
  message?: string;
}

export function classifyMergeError(
  error: unknown,
): "github_auth_failure" | "github_merge_failure" | "pr_already_merged" {
  if (error instanceof GitHubApiError) {
    if (error.status === 401) {
      return "github_auth_failure";
    }
    if (error.status === 409) {
      return "pr_already_merged";
    }
    if (error.status === 405) {
      const message = error.message.toLowerCase();
      if (message.includes("already been merged") || message.includes("already merged")) {
        return "pr_already_merged";
      }
    }
  }
  return "github_merge_failure";
}

export function isAlreadyMergedError(error: unknown): boolean {
  return classifyMergeError(error) === "pr_already_merged";
}
