import { describe, expect, it, vi } from "vitest";
import { GitHubApiError } from "../../src/github/client.js";
import {
  assertBaseBranchExists,
  assertHeadBranchWritePermission,
  assertPrBaseBranchMatches,
  assertPullRequestMergeable,
  isIntegrationRepairEligible,
  parseGitHubRepoUrl,
} from "../../src/github/base-branch.js";

describe("parseGitHubRepoUrl", () => {
  it("parses canonical GitHub HTTPS URLs", () => {
    expect(
      parseGitHubRepoUrl("https://github.com/owner/example-target-app"),
    ).toEqual({
      owner: "owner",
      repo: "example-target-app",
    });
  });

  it("returns null for invalid URLs", () => {
    expect(parseGitHubRepoUrl("not-a-repo-url")).toBeNull();
  });
});

describe("assertBaseBranchExists", () => {
  it("resolves when branch ref exists", async () => {
    const client = {
      getBranchRef: vi.fn().mockResolvedValue({ object: { sha: "abc" } }),
    };

    await expect(
      assertBaseBranchExists(
        client as never,
        "https://github.com/owner/example-target-app",
        "dev",
      ),
    ).resolves.toBeUndefined();
  });

  it("throws base_branch_missing when branch ref is 404", async () => {
    const client = {
      getBranchRef: vi
        .fn()
        .mockRejectedValue(new GitHubApiError(404, "Not Found")),
    };

    await expect(
      assertBaseBranchExists(
        client as never,
        "https://github.com/owner/example-target-app",
        "dev",
      ),
    ).rejects.toThrow(/base_branch_missing/);
  });
});

describe("assertPullRequestMergeable", () => {
  it("passes when PR is mergeable", () => {
    expect(() =>
      assertPullRequestMergeable({
        prUrl: "https://github.com/o/r/pull/1",
        merged: false,
        mergeable: true,
        mergeableState: "clean",
        baseBranch: "dev",
      }),
    ).not.toThrow();
  });

  it("passes when PR is already merged", () => {
    expect(() =>
      assertPullRequestMergeable({
        prUrl: "https://github.com/o/r/pull/1",
        merged: true,
        mergeable: false,
        mergeableState: "dirty",
        baseBranch: "dev",
      }),
    ).not.toThrow();
  });

  it("throws pr_not_mergeable when PR is dirty", () => {
    expect(() =>
      assertPullRequestMergeable({
        prUrl: "https://github.com/o/r/pull/1",
        merged: false,
        mergeable: false,
        mergeableState: "dirty",
        baseBranch: "dev",
      }),
    ).toThrow(/pr_not_mergeable/);
  });
});

describe("isIntegrationRepairEligible", () => {
  it("allows dirty and behind PRs", () => {
    expect(
      isIntegrationRepairEligible({ mergeable: false, mergeableState: "dirty" }),
    ).toBe(true);
    expect(
      isIntegrationRepairEligible({ mergeable: false, mergeableState: "behind" }),
    ).toBe(true);
  });

  it("does not repair blocked PRs", () => {
    expect(
      isIntegrationRepairEligible({ mergeable: false, mergeableState: "blocked" }),
    ).toBe(false);
  });
});

describe("assertHeadBranchWritePermission", () => {
  it("passes when repo permissions include push", async () => {
    const client = {
      getRepository: vi.fn().mockResolvedValue({ permissions: { push: true } }),
    };

    await expect(
      assertHeadBranchWritePermission(client as never, "https://github.com/o/r"),
    ).resolves.toBeUndefined();
  });

  it("throws setup guidance when write is missing", async () => {
    const client = {
      getRepository: vi.fn().mockResolvedValue({ permissions: { pull: true } }),
    };

    await expect(
      assertHeadBranchWritePermission(client as never, "https://github.com/o/r"),
    ).rejects.toThrow(/repair_head_branch_write_denied/);
  });
});

describe("assertPrBaseBranchMatches", () => {
  it("passes when PR base matches config", () => {
    expect(() =>
      assertPrBaseBranchMatches({
        prUrl: "https://github.com/o/r/pull/1",
        actualBaseBranch: "dev",
        expectedBaseBranch: "dev",
      }),
    ).not.toThrow();
  });

  it("throws wrong_pr_base_branch when PR base differs", () => {
    expect(() =>
      assertPrBaseBranchMatches({
        prUrl: "https://github.com/o/r/pull/1",
        actualBaseBranch: "main",
        expectedBaseBranch: "dev",
      }),
    ).toThrow(/wrong_pr_base_branch/);
  });
});
