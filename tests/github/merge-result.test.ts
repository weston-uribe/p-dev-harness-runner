import { describe, expect, it } from "vitest";
import { GitHubApiError } from "../../src/github/client.js";
import {
  classifyMergeError,
  isAlreadyMergedError,
} from "../../src/github/merge-result.js";

describe("merge-result", () => {
  it("classifies 405 as merge failure when PR is not mergeable", () => {
    const error = new GitHubApiError(405, "Pull Request is not mergeable");
    expect(classifyMergeError(error)).toBe("github_merge_failure");
    expect(isAlreadyMergedError(error)).toBe(false);
  });

  it("classifies 409 as already merged", () => {
    const error = new GitHubApiError(409, "Pull Request already merged");
    expect(classifyMergeError(error)).toBe("pr_already_merged");
    expect(isAlreadyMergedError(error)).toBe(true);
  });

  it("classifies 405 as already merged when message says merged", () => {
    const error = new GitHubApiError(405, "Pull Request has already been merged");
    expect(classifyMergeError(error)).toBe("pr_already_merged");
    expect(isAlreadyMergedError(error)).toBe(true);
  });
});
