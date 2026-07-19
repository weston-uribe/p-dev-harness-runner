import { describe, expect, it } from "vitest";
import type { GitHubCompareResult } from "../../src/github/client.js";
import {
  isCommitReachableFromBranch,
  resolvePromotionProof,
} from "../../src/github/commit-reachability.js";

class MockGitHubClient {
  compareResults: GitHubCompareResult[] = [];
  branchHead = "prod-head-sha";
  pullMergeCommit = "pr-merge-sha";

  async getBranchRef() {
    return { ref: "refs/heads/main", object: { sha: this.branchHead, type: "commit", url: "" } };
  }

  async compareCommits() {
    return this.compareResults.shift() ?? {
      status: "diverged",
      ahead_by: 0,
      behind_by: 1,
      commits: [],
    };
  }

  async getPullRequest() {
    return {
      node_id: "pr-node",
      title: "Test PR",
      html_url: "https://github.com/o/r/pull/1",
      state: "closed",
      merged: true,
      merged_at: "2026-07-07T00:00:00.000Z",
      merge_commit_sha: this.pullMergeCommit,
      head: { ref: "cursor/wes-1-test", sha: "head-sha" },
      base: { ref: "dev" },
    };
  }
}

describe("commit reachability", () => {
  it("treats identical production head as reachable", async () => {
    const client = new MockGitHubClient();
    client.compareResults = [{ status: "identical", ahead_by: 0, behind_by: 0, commits: [] }];

    const result = await isCommitReachableFromBranch(
      client as never,
      "o",
      "r",
      "merge-sha",
      "main",
    );

    expect(result.reachable).toBe(true);
  });

  it("treats descendant production head as reachable", async () => {
    const client = new MockGitHubClient();
    client.compareResults = [{ status: "ahead", ahead_by: 2, behind_by: 0, commits: [] }];

    const result = await isCommitReachableFromBranch(
      client as never,
      "o",
      "r",
      "merge-sha",
      "main",
    );

    expect(result.reachable).toBe(true);
  });

  it("treats diverged history as not reachable", async () => {
    const client = new MockGitHubClient();
    client.compareResults = [{ status: "diverged", ahead_by: 1, behind_by: 2, commits: [] }];

    const result = await isCommitReachableFromBranch(
      client as never,
      "o",
      "r",
      "merge-sha",
      "main",
    );

    expect(result.reachable).toBe(false);
  });

  it("treats production head behind merge commit as not reachable", async () => {
    const client = new MockGitHubClient();
    client.compareResults = [{ status: "behind", ahead_by: 0, behind_by: 3, commits: [] }];

    const result = await isCommitReachableFromBranch(
      client as never,
      "o",
      "r",
      "merge-sha",
      "main",
    );

    expect(result.reachable).toBe(false);
  });
});

describe("resolvePromotionProof", () => {
  it("promotes when stored merge commit is reachable", async () => {
    const client = new MockGitHubClient();
    client.compareResults = [{ status: "ahead", ahead_by: 1, behind_by: 0, commits: [] }];

    const proof = await resolvePromotionProof({
      client: client as never,
      targetRepo: "https://github.com/o/r",
      productionBranch: "main",
      mergeCommitSha: "merge-sha",
    });

    expect(proof.proof).toBe(true);
    if (proof.proof) {
      expect(proof.method).toBe("merge_commit_sha");
    }
  });

  it("does not promote on issue-key diagnostic evidence alone", async () => {
    const client = new MockGitHubClient();
    client.compareResults = [
      { status: "behind", ahead_by: 0, behind_by: 2, commits: [] },
      {
        status: "ahead",
        ahead_by: 1,
        behind_by: 0,
        commits: [{ sha: "diag1", commit: { message: "Fix WES-1 footer" } }],
      },
    ];

    const proof = await resolvePromotionProof({
      client: client as never,
      targetRepo: "https://github.com/o/r",
      productionBranch: "main",
      baseBranch: "dev",
      mergeCommitSha: "missing-on-main",
      issueKey: "WES-1",
    });

    expect(proof.proof).toBe(false);
    if (!proof.proof) {
      expect(proof.reason).toBe("production_not_promoted");
      expect(proof.diagnosticIssueKeyCommits).toEqual(["diag1"]);
    }
  });
});
