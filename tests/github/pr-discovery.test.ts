import { describe, expect, it } from "vitest";
import {
  buildIssueKeyBranchPattern,
  findImplementationPullRequest,
  headBranchMatchesIssueKey,
} from "../../src/github/pr-discovery.js";
import type { GitHubPullRequestListItem } from "../../src/github/client.js";

class MockGitHubClient {
  pulls: GitHubPullRequestListItem[] = [];

  async listPullRequests() {
    return this.pulls;
  }
}

describe("pr discovery", () => {
  it("matches issue key in branch name case-insensitively", () => {
    expect(headBranchMatchesIssueKey("cursor/wes-13-hello-world", "WES-13")).toBe(true);
    expect(headBranchMatchesIssueKey("cursor/other-branch", "WES-13")).toBe(false);
    expect(buildIssueKeyBranchPattern("WES-13").test("cursor/WES-13-test")).toBe(true);
  });

  it("returns most recent matching open PR on base branch", async () => {
    const client = new MockGitHubClient();
    client.pulls = [
      {
        number: 4,
        html_url: "https://github.com/o/r/pull/4",
        state: "open",
        created_at: "2026-07-07T02:00:00.000Z",
        head: { ref: "cursor/wes-13-new", sha: "sha-new" },
        base: { ref: "dev" },
      },
      {
        number: 3,
        html_url: "https://github.com/o/r/pull/3",
        state: "open",
        created_at: "2026-07-07T01:00:00.000Z",
        head: { ref: "cursor/wes-13-old", sha: "sha-old" },
        base: { ref: "dev" },
      },
    ];

    const discovered = await findImplementationPullRequest(
      client as never,
      "https://github.com/o/r",
      "dev",
      "WES-13",
    );

    expect(discovered?.prNumber).toBe(4);
    expect(discovered?.branch).toBe("cursor/wes-13-new");
  });
});
