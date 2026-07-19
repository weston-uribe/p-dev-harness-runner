import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GitHubClient, GitHubApiError } from "../../src/github/client.js";

const mockFetch = vi.fn();
const SENTINEL_SECRET = "ghp_sentinelSecretValueForClientTests";

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  };
}

function emptyBodyResponse(status: number) {
  return {
    ok: true,
    status,
    text: async () => "",
  };
}

describe("GitHubClient", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", mockFetch);
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("marks draft PR ready via GraphQL mutation", async () => {
    const pull = {
      node_id: "PR_kwDOExample",
      title: "[WES-18] test",
      html_url: "https://github.com/owner/example-target-app/pull/7",
      state: "open",
      merged: false,
      draft: true,
      merged_at: null,
      merge_commit_sha: null,
      head: { ref: "cursor/wes-18-test", sha: "abc123" },
      base: { ref: "main" },
    };

    mockFetch
      .mockResolvedValueOnce(jsonResponse(200, pull))
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          data: {
            markPullRequestReadyForReview: {
              pullRequest: { isDraft: false },
            },
          },
        }),
      })
      .mockResolvedValueOnce(jsonResponse(200, { ...pull, draft: false }));

    const client = new GitHubClient({ token: "test-token" });
    const result = await client.markPullRequestReadyForReview(
      "weston-uribe",
      "example-target-app",
      7,
    );

    expect(result.draft).toBe(false);
    expect(mockFetch).toHaveBeenCalledTimes(3);
    const graphqlCall = mockFetch.mock.calls[1];
    expect(graphqlCall[0]).toBe("https://api.github.com/graphql");
    expect(graphqlCall[1]?.method).toBe("POST");
    const body = JSON.parse(String(graphqlCall[1]?.body));
    expect(body.variables.pullRequestId).toBe("PR_kwDOExample");
    expect(body.query).toContain("markPullRequestReadyForReview");
    const patchCalls = mockFetch.mock.calls.filter(
      ([url, init]) =>
        String(url).includes("/pulls/7") && init?.method === "PATCH",
    );
    expect(patchCalls).toHaveLength(0);
  });

  it("throws when GraphQL mutation returns errors", async () => {
    mockFetch
      .mockResolvedValueOnce(
        jsonResponse(200, {
          node_id: "PR_kwDOExample",
          title: "test",
          html_url: "https://github.com/example/repo/pull/1",
          state: "open",
          merged: false,
          draft: true,
          merged_at: null,
          merge_commit_sha: null,
          head: { ref: "branch", sha: "abc" },
          base: { ref: "main" },
        }),
      )
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          errors: [{ message: "Resource not accessible by integration" }],
        }),
      });

    const client = new GitHubClient({ token: "test-token" });
    await expect(
      client.markPullRequestReadyForReview("owner", "repo", 1),
    ).rejects.toBeInstanceOf(GitHubApiError);
  });

  it("merges a PR with expected head sha", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse(200, { sha: "merged-sha", merged: true }),
    );

    const client = new GitHubClient({ token: "test-token" });
    const result = await client.mergePullRequest("owner", "repo", 12, {
      mergeMethod: "squash",
      commitTitle: "Merge PR",
      expectedHeadSha: "abc123",
    });

    expect(result.sha).toBe("merged-sha");
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0]!;
    expect(url).toBe("https://api.github.com/repos/owner/repo/pulls/12/merge");
    expect(init?.method).toBe("PUT");
    expect(JSON.parse(String(init?.body))).toEqual({
      merge_method: "squash",
      commit_title: "Merge PR",
      sha: "abc123",
    });
  });

  it("updates a PR branch with expected head sha", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse(202, { message: "Updating pull request branch." }),
    );

    const client = new GitHubClient({ token: "test-token" });
    const result = await client.updatePullRequestBranch("owner", "repo", 12, {
      expectedHeadSha: "abc123",
    });

    expect(result.message).toContain("Updating");
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0]!;
    expect(url).toBe(
      "https://api.github.com/repos/owner/repo/pulls/12/update-branch",
    );
    expect(init?.method).toBe("PUT");
    expect(JSON.parse(String(init?.body))).toEqual({
      expected_head_sha: "abc123",
    });
  });

  it("upsertActionsSecret resolves for 201 create with empty body", async () => {
    mockFetch.mockResolvedValueOnce(emptyBodyResponse(201));

    const client = new GitHubClient({ token: "test-token" });
    await expect(
      client.upsertActionsSecret(
        "owner",
        "repo",
        "LINEAR_API_KEY",
        "encrypted:payload",
        "public-key-id",
      ),
    ).resolves.toBeUndefined();

    const [url, init] = mockFetch.mock.calls[0]!;
    expect(url).toBe(
      "https://api.github.com/repos/owner/repo/actions/secrets/LINEAR_API_KEY",
    );
    expect(init?.method).toBe("PUT");
    expect(JSON.parse(String(init?.body))).toEqual({
      encrypted_value: "encrypted:payload",
      key_id: "public-key-id",
    });
  });

  it("upsertActionsSecret resolves for 204 update with empty body", async () => {
    mockFetch.mockResolvedValueOnce(emptyBodyResponse(204));

    const client = new GitHubClient({ token: "test-token" });
    await expect(
      client.upsertActionsSecret(
        "owner",
        "repo",
        "CURSOR_API_KEY",
        "encrypted:payload",
        "public-key-id",
      ),
    ).resolves.toBeUndefined();
  });

  it("upsertActionsSecret throws sanitized GitHubApiError for non-2xx responses", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 403,
      text: async () => `token ${SENTINEL_SECRET} is invalid`,
    });

    const client = new GitHubClient({ token: "test-token" });
    let caught: GitHubApiError | undefined;
    try {
      await client.upsertActionsSecret(
        "owner",
        "repo",
        "HARNESS_GITHUB_TOKEN",
        "encrypted:payload",
        "public-key-id",
      );
    } catch (error) {
      caught = error as GitHubApiError;
    }

    expect(caught).toBeInstanceOf(GitHubApiError);
    expect(caught?.status).toBe(403);
    expect(caught?.message).not.toContain(SENTINEL_SECRET);
    expect(JSON.stringify(caught)).not.toContain(SENTINEL_SECRET);
  });
});
