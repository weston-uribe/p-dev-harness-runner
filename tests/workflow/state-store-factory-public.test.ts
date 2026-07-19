import { describe, expect, it, vi } from "vitest";
import { GitHubApiError } from "../../src/github/client.js";
import {
  createWorkflowStateStore,
  WorkflowStateStoreError,
} from "../../src/workflow/state/factory.js";
import { GithubWorkflowStateStore } from "../../src/workflow/state/github-store.js";

function createFakeGitHubClient() {
  const seen = { owner: "", repo: "", branch: "" };
  const client = {
    getGitRef: vi.fn(async (owner: string, repo: string, branch: string) => {
      seen.owner = owner;
      seen.repo = repo;
      seen.branch = branch;
      return {
        ref: `refs/heads/${branch}`,
        object: { sha: "branchsha" },
      };
    }),
    getRepository: vi.fn(async () => ({ default_branch: "main" })),
    createGitRef: vi.fn(),
    getRepositoryContent: vi.fn(async () => null),
    decodeRepositoryContent: (content: { content: string }) =>
      Buffer.from(content.content, "base64").toString("utf8"),
    createOrUpdateRepositoryFile: vi.fn(),
  };
  return { client, seen };
}

describe("createWorkflowStateStore managed_github state repository", () => {
  it("throws when P_DEV_WORKFLOW_STATE_REPOSITORY is missing", async () => {
    await expect(
      createWorkflowStateStore({
        mode: "managed_github",
        teamId: "team-1",
        githubToken: "ghp_test",
        env: {
          GITHUB_REPOSITORY: "execution-owner/execution-repo",
          GITHUB_DISPATCH_REPOSITORY: "execution-owner/execution-repo",
        },
      }),
    ).rejects.toMatchObject({
      code: "managed_store_missing_state_repository",
    });
  });

  it("does not fall back to FileWorkflowStateStore for managed_github", async () => {
    await expect(
      createWorkflowStateStore({
        mode: "managed_github",
        teamId: "team-1",
        env: {},
      }),
    ).rejects.toBeInstanceOf(WorkflowStateStoreError);

    const store = await createWorkflowStateStore({
      mode: "file",
      logDirectory: "/tmp/p-dev-workflow-state-factory-test",
      env: {},
    });
    expect(store.constructor.name).toBe("FileWorkflowStateStore");
  });

  it("uses the configured state repository instead of GITHUB_REPOSITORY", async () => {
    const { client, seen } = createFakeGitHubClient();
    const store = await createWorkflowStateStore({
      mode: "managed_github",
      teamId: "team-1",
      githubToken: "state-token",
      githubClient: client as never,
      env: {
        P_DEV_WORKFLOW_STATE_REPOSITORY: "state-owner/state-repo",
        P_DEV_WORKFLOW_STATE_BRANCH: "p-dev-runtime-state",
        GITHUB_REPOSITORY: "execution-owner/execution-repo",
        GITHUB_DISPATCH_REPOSITORY: "execution-owner/execution-repo",
      },
    });

    expect(store).toBeInstanceOf(GithubWorkflowStateStore);
    expect(seen.owner).toBe("state-owner");
    expect(seen.repo).toBe("state-repo");
    expect(seen.branch).toBe("p-dev-runtime-state");
    expect(seen.owner).not.toBe("execution-owner");
    expect(seen.repo).not.toBe("execution-repo");
  });

  it("prefers P_DEV_STATE_GITHUB_TOKEN for managed_github", async () => {
    const { client, seen } = createFakeGitHubClient();
    await createWorkflowStateStore({
      mode: "managed_github",
      teamId: "team-1",
      githubClient: client as never,
      env: {
        P_DEV_WORKFLOW_STATE_REPOSITORY: "state-owner/state-repo",
        P_DEV_STATE_GITHUB_TOKEN: "state-only-token",
        GITHUB_TOKEN: "execution-token",
      },
    });
    expect(seen.owner).toBe("state-owner");
    expect(seen.repo).toBe("state-repo");
  });

  it("surfaces branch init failures as managed_store_init_failed", async () => {
    const client = {
      getGitRef: vi.fn(async () => {
        throw new GitHubApiError(500, "branch lookup failed");
      }),
      getRepository: vi.fn(),
      createGitRef: vi.fn(),
      getRepositoryContent: vi.fn(),
      decodeRepositoryContent: vi.fn(),
      createOrUpdateRepositoryFile: vi.fn(),
    };

    await expect(
      createWorkflowStateStore({
        mode: "managed_github",
        teamId: "team-1",
        githubToken: "state-token",
        githubClient: client as never,
        env: {
          P_DEV_WORKFLOW_STATE_REPOSITORY: "state-owner/state-repo",
        },
      }),
    ).rejects.toMatchObject({
      code: "managed_store_init_failed",
    });
  });
});
