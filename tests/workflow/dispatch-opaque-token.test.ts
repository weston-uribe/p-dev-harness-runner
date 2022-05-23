import { describe, expect, it, vi } from "vitest";
import { GitHubApiError } from "../../src/github/client.js";
import {
  createCodeReviewJobAndDispatch,
  createEnvelopeAndDispatch,
} from "../../src/workflow/job-request/dispatch-opaque.js";

function createFakeGitHubClient() {
  const files = new Map<string, { sha: string; content: string }>();
  let shaCounter = 0;

  const client = {
    getGitRef: vi.fn(async () => ({
      ref: "refs/heads/p-dev-runtime-state",
      object: { sha: "branchsha" },
    })),
    getRepository: vi.fn(async () => ({ default_branch: "main" })),
    createGitRef: vi.fn(),
    getRepositoryContent: vi.fn(
      async (_o: string, _r: string, path: string) => {
        const hit = files.get(path);
        if (!hit) return null;
        return {
          name: path.split("/").pop()!,
          path,
          sha: hit.sha,
          content: Buffer.from(hit.content, "utf8").toString("base64"),
          encoding: "base64",
        };
      },
    ),
    decodeRepositoryContent: (content: { content: string }) =>
      Buffer.from(content.content, "base64").toString("utf8"),
    createOrUpdateRepositoryFile: vi.fn(
      async (input: { path: string; content: string; sha?: string }) => {
        const existing = files.get(input.path);
        if (input.sha) {
          if (!existing || existing.sha !== input.sha) {
            throw new GitHubApiError(409, "sha mismatch");
          }
        } else if (existing) {
          throw new GitHubApiError(422, "already exists");
        }
        shaCounter += 1;
        const sha = `sha-${shaCounter}`;
        files.set(input.path, { sha, content: input.content });
        return { commitSha: `commit-${shaCounter}` };
      },
    ),
  };

  return { client };
}

const baseEnv = {
  P_DEV_STATE_GITHUB_TOKEN: "state-present",
  P_DEV_JOB_REQUEST_REPOSITORY: "state-owner/state-repo",
  GITHUB_DISPATCH_REPOSITORY: "exec-owner/exec-repo",
};

describe("createEnvelopeAndDispatch token resolution", () => {
  it("uses GITHUB_DISPATCH_TOKEN when present", async () => {
    const { client } = createFakeGitHubClient();
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));

    const result = await createEnvelopeAndDispatch({
      issueKey: "FRE-5",
      triggerSource: "test",
      linearDeliveryId: "delivery-dispatch-token",
      ackRequired: false,
      env: {
        ...baseEnv,
        GITHUB_DISPATCH_TOKEN: "dispatch-present",
        HARNESS_GITHUB_TOKEN: "harness-present",
        GITHUB_TOKEN: "github-present",
      },
      githubClient: client as never,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    expect(result.dispatched).toBe(true);
    expect(fetchMock).toHaveBeenCalledOnce();
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(init.headers).toMatchObject({
      Authorization: "Bearer dispatch-present",
    });
  });

  it("falls back to HARNESS_GITHUB_TOKEN when GITHUB_DISPATCH_TOKEN is absent", async () => {
    const { client } = createFakeGitHubClient();
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));

    await createEnvelopeAndDispatch({
      issueKey: "FRE-5",
      triggerSource: "test",
      linearDeliveryId: "delivery-harness-token",
      ackRequired: false,
      env: {
        ...baseEnv,
        HARNESS_GITHUB_TOKEN: "harness-present",
        GITHUB_TOKEN: "github-present",
      },
      githubClient: client as never,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(init.headers).toMatchObject({
      Authorization: "Bearer harness-present",
    });
  });

  it("throws missing_dispatch_token when only GITHUB_TOKEN is present", async () => {
    const { client } = createFakeGitHubClient();
    await expect(
      createEnvelopeAndDispatch({
        issueKey: "FRE-5",
        triggerSource: "test",
        linearDeliveryId: "delivery-github-only",
        ackRequired: false,
        env: {
          ...baseEnv,
          GITHUB_TOKEN: "github-present",
        },
        githubClient: client as never,
        fetchImpl: vi.fn() as unknown as typeof fetch,
      }),
    ).rejects.toThrow("missing_dispatch_token");
  });

  it("createCodeReviewJobAndDispatch throws missing_dispatch_token without dispatch credential", async () => {
    const { client } = createFakeGitHubClient();
    await expect(
      createCodeReviewJobAndDispatch({
        issueKey: "FRE-5",
        reviewSubjectIdentity: "subject-abc",
        env: {
          ...baseEnv,
          GITHUB_TOKEN: "github-present",
        },
        githubClient: client as never,
        fetchImpl: vi.fn() as unknown as typeof fetch,
      }),
    ).rejects.toThrow("missing_dispatch_token");
  });
});
