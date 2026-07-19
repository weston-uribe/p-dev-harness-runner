import { describe, expect, it, vi } from "vitest";
import { GitHubApiError } from "../../src/github/client.js";
import {
  classifyGitHubError,
  inspectPullRequest,
  inspectPullRequestForMerge,
  inspectPullRequestPostMerge,
  pollPullRequestMergeability,
} from "../../src/github/pr-inspector.js";

const ACTUAL_HEAD_SHA = "actual-head-sha";
const SYNTHETIC_MERGE_SHA = "synthetic-merge-sha";

function openPullWithSyntheticMergeCommit(overrides: Record<string, unknown> = {}) {
  return {
    title: "Install harness production sync workflow",
    html_url: "https://github.com/o/r/pull/27",
    head: { ref: "harness/setup-production-sync-target-app", sha: ACTUAL_HEAD_SHA },
    base: { ref: "main" },
    state: "open",
    merged: false,
    mergeable: true,
    mergeable_state: "clean",
    merged_at: null,
    merge_commit_sha: SYNTHETIC_MERGE_SHA,
    ...overrides,
  };
}

function createMockClient(overrides: {
  pull?: Record<string, unknown>;
  files?: { filename: string; status: string }[];
  checks?: { check_runs: Record<string, unknown>[] };
  combinedStatus?: (ref: string) => {
    state: string;
    statuses: Array<{
      context: string;
      state: string;
      target_url: string | null;
    }>;
  };
  comments?: { user: { login: string }; body: string; created_at: string }[];
  pullError?: Error;
  checkRunsForRef?: (ref: string) => { check_runs: Record<string, unknown>[] };
}) {
  return {
    getPullRequest: vi.fn(async () => {
      if (overrides.pullError) {
        throw overrides.pullError;
      }
      return overrides.pull ?? {
        title: "Test PR",
        html_url: "https://github.com/o/r/pull/4",
        head: { ref: "cursor/wes-13-test", sha: "abc123" },
        base: { ref: "main" },
        state: "open",
        merged: false,
      };
    }),
    getPullRequestFiles: vi.fn(async () => overrides.files ?? []),
    getCheckRunsForRef: vi.fn(async (_owner, _repo, ref: string) => {
      if (overrides.checkRunsForRef) {
        return overrides.checkRunsForRef(ref);
      }
      return overrides.checks ?? { check_runs: [] };
    }),
    getCombinedStatusForRef: vi.fn(async (_owner, _repo, ref: string) => {
      if (overrides.combinedStatus) {
        return overrides.combinedStatus(ref);
      }
      return { state: "pending", statuses: [] };
    }),
    getIssueComments: vi.fn(async () => overrides.comments ?? []),
  };
}

function expectCheckRefsUseActualHeadOnly(
  client: ReturnType<typeof createMockClient>,
): void {
  const checkRefs = client.getCheckRunsForRef.mock.calls.map((call) => call[2]);
  const statusRefs = client.getCombinedStatusForRef.mock.calls.map((call) => call[2]);
  for (const ref of [...checkRefs, ...statusRefs]) {
    expect(ref).toBe(ACTUAL_HEAD_SHA);
    expect(ref).not.toBe(SYNTHETIC_MERGE_SHA);
  }
}

describe("inspectPullRequest", () => {
  const parsed = {
    owner: "o",
    repo: "r",
    pullNumber: 4,
    repoUrl: "https://github.com/o/r",
  };

  it("returns inspection details for an open PR", async () => {
    const client = createMockClient({
      files: [{ filename: "src/page.tsx", status: "modified" }],
      checks: {
        check_runs: [
          {
            name: "CI",
            status: "completed",
            conclusion: "success",
            details_url: "https://github.com/o/r/runs/1",
          },
        ],
      },
      comments: [
        {
          user: { login: "vercel[bot]" },
          body: "[Preview](https://example.vercel.app)",
          created_at: "2026-07-07T00:00:00Z",
        },
      ],
    });

    const result = await inspectPullRequest(
      client as never,
      parsed,
      "https://github.com/o/r",
    );

    expect(result.url).toContain("/pull/4");
    expect(result.branch).toBe("cursor/wes-13-test");
    expect(result.headSha).toBe("abc123");
    expect(result.isDraft).toBe(false);
    expect(result.changedFiles).toHaveLength(1);
    expect(result.checkSummary).toContain("Passed: 1");
    expect(result.comments[0]?.author).toBe("vercel[bot]");
  });

  it("throws when PR repo does not match expected target repo", async () => {
    const client = createMockClient({});

    await expect(
      inspectPullRequest(
        client as never,
        parsed,
        "https://github.com/other/repo",
      ),
    ).rejects.toThrow(/wrong_target_repo/);
  });

  it("throws when PR is closed", async () => {
    const client = createMockClient({
      pull: {
        title: "Closed PR",
        html_url: "https://github.com/o/r/pull/4",
        head: { ref: "branch", sha: "abc" },
        base: { ref: "main" },
        state: "closed",
        merged: false,
      },
    });

    await expect(
      inspectPullRequest(client as never, parsed, "https://github.com/o/r"),
    ).rejects.toThrow(/pr_closed/);
  });

  it("queries check runs on pull.head.sha when merge_commit_sha differs on open PR", async () => {
    const client = createMockClient({
      pull: openPullWithSyntheticMergeCommit(),
      checkRunsForRef: (ref) => ({
        check_runs:
          ref === ACTUAL_HEAD_SHA
            ? [
                {
                  name: "Vercel",
                  status: "completed",
                  conclusion: "success",
                  details_url: "https://vercel.com/deploy",
                },
              ]
            : [],
      }),
    });

    const result = await inspectPullRequest(
      client as never,
      {
        owner: "o",
        repo: "r",
        pullNumber: 27,
        repoUrl: "https://github.com/o/r",
      },
      "https://github.com/o/r",
    );

    expect(result.headSha).toBe(ACTUAL_HEAD_SHA);
    expect(result.mergeCommitSha).toBe(SYNTHETIC_MERGE_SHA);
    expect(result.checkSummary).toContain("Passed: 1");
    expectCheckRefsUseActualHeadOnly(client);
  });

  it("queries combined commit statuses on pull.head.sha when merge_commit_sha differs", async () => {
    const client = createMockClient({
      pull: openPullWithSyntheticMergeCommit(),
      checkRunsForRef: () => ({ check_runs: [] }),
      combinedStatus: (ref) =>
        ref === ACTUAL_HEAD_SHA
          ? {
              state: "success",
              statuses: [
                {
                  context: "Vercel",
                  state: "success",
                  target_url: "https://vercel.com/deploy",
                },
              ],
            }
          : { state: "pending", statuses: [] },
    });

    const result = await inspectPullRequest(
      client as never,
      {
        owner: "o",
        repo: "r",
        pullNumber: 27,
        repoUrl: "https://github.com/o/r",
      },
      "https://github.com/o/r",
    );

    expect(result.headSha).toBe(ACTUAL_HEAD_SHA);
    expect(result.mergeCommitSha).toBe(SYNTHETIC_MERGE_SHA);
    expect(result.checkSummary).toContain("Passed: 1");
    expectCheckRefsUseActualHeadOnly(client);
  });

  it("does not treat synthetic merge_commit_sha success as passing checks on open PR", async () => {
    const client = createMockClient({
      pull: openPullWithSyntheticMergeCommit(),
      checkRunsForRef: (ref) => ({
        check_runs:
          ref === SYNTHETIC_MERGE_SHA
            ? [
                {
                  name: "Vercel",
                  status: "completed",
                  conclusion: "success",
                  details_url: null,
                },
              ]
            : [],
      }),
    });

    const result = await inspectPullRequest(
      client as never,
      {
        owner: "o",
        repo: "r",
        pullNumber: 27,
        repoUrl: "https://github.com/o/r",
      },
      "https://github.com/o/r",
    );

    expect(result.checkSummary).not.toContain("Passed: 1");
    expect(result.checks.some((c) => c.conclusion === "success")).toBe(false);
    expect(client.getCheckRunsForRef).toHaveBeenCalledWith(
      "o",
      "r",
      ACTUAL_HEAD_SHA,
    );
    expect(client.getCheckRunsForRef).not.toHaveBeenCalledWith(
      "o",
      "r",
      SYNTHETIC_MERGE_SHA,
    );
  });

  it("polls until GitHub computes mergeability", async () => {
    const client = createMockClient({});
    client.getPullRequest
      .mockResolvedValueOnce({
        title: "Test PR",
        html_url: "https://github.com/o/r/pull/4",
        head: { ref: "cursor/wes-13-test", sha: "abc123" },
        base: { ref: "main" },
        state: "open",
        merged: false,
        mergeable: null,
        mergeable_state: "unknown",
        merged_at: null,
        merge_commit_sha: null,
      })
      .mockResolvedValueOnce({
        title: "Test PR",
        html_url: "https://github.com/o/r/pull/4",
        head: { ref: "cursor/wes-13-test", sha: "def456" },
        base: { ref: "main" },
        state: "open",
        merged: false,
        mergeable: true,
        mergeable_state: "clean",
        merged_at: null,
        merge_commit_sha: null,
      });

    const result = await pollPullRequestMergeability(
      client as never,
      parsed,
      "https://github.com/o/r",
      { timeoutSeconds: 1, intervalSeconds: 0 },
    );

    expect(result.mergeableState).toBe("clean");
    expect(result.headSha).toBe("def456");
  });
});

describe("inspectPullRequestForMerge / inspectPullRequestPostMerge", () => {
  const parsed = {
    owner: "o",
    repo: "r",
    pullNumber: 27,
    repoUrl: "https://github.com/o/r",
  };

  it("queries checks on pull.head.sha for merged PRs and preserves mergeCommitSha", async () => {
    const client = createMockClient({
      pull: openPullWithSyntheticMergeCommit({
        state: "closed",
        merged: true,
        merged_at: "2026-07-13T00:00:00Z",
        merge_commit_sha: "merged-on-main-sha",
        head: {
          ref: "harness/setup-production-sync-target-app",
          sha: ACTUAL_HEAD_SHA,
        },
      }),
      checkRunsForRef: (ref) => ({
        check_runs:
          ref === ACTUAL_HEAD_SHA
            ? [
                {
                  name: "Vercel",
                  status: "completed",
                  conclusion: "success",
                  details_url: null,
                },
              ]
            : [],
      }),
    });

    const forMerge = await inspectPullRequestForMerge(
      client as never,
      parsed,
      "https://github.com/o/r",
    );
    const postMerge = await inspectPullRequestPostMerge(
      client as never,
      parsed,
      "https://github.com/o/r",
    );

    for (const result of [forMerge, postMerge]) {
      expect(result.merged).toBe(true);
      expect(result.headSha).toBe(ACTUAL_HEAD_SHA);
      expect(result.mergeCommitSha).toBe("merged-on-main-sha");
      expect(result.checkSummary).toContain("Passed: 1");
    }

    expect(client.getCheckRunsForRef).toHaveBeenCalledWith(
      "o",
      "r",
      ACTUAL_HEAD_SHA,
    );
    expect(client.getCheckRunsForRef).not.toHaveBeenCalledWith(
      "o",
      "r",
      "merged-on-main-sha",
    );
    expect(client.getPullRequestFiles).not.toHaveBeenCalled();
  });
});

describe("classifyGitHubError", () => {
  it("classifies 401 as github_auth_failure", () => {
    expect(
      classifyGitHubError(new GitHubApiError(401, "Unauthorized")),
    ).toBe("github_auth_failure");
  });

  it("classifies other errors as github_api_failure", () => {
    expect(classifyGitHubError(new Error("network"))).toBe("github_api_failure");
  });
});
