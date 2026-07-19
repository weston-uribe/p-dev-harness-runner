import { createHash } from "node:crypto";
import {
  GitHubApiError,
  GitHubClient,
  type GitHubClientOptions,
  type GitHubWorkflowRun,
} from "../github/client.js";
import {
  createLiveGitHubRemoteSetupProvider,
  preserveGitHubSetupError,
} from "./github-remote-setup-live.js";
import type {
  GitBlobResult,
  GitCommitIdentity,
  GitCommitResult,
  GitRefResult,
  GitTreeEntryInput,
  GitTreeResult,
  HarnessSecretWriteRequest,
  HarnessSecretWriteResultEntry,
  HarnessVariableWriteRequest,
  HarnessVariableWriteResultEntry,
} from "./github-remote-provider.js";
import type {
  RunnerUpgradeGitHubProvider,
  RunnerUpgradeProviderCallOptions,
  RunnerUpgradePullRequest,
  RunnerUpgradeRepositoryMetadata,
  RunnerUpgradeWorkflowRun,
} from "./runner-upgrade-provider.js";

function normalizeBranchRef(ref: string): string {
  if (ref.startsWith("refs/heads/")) {
    return ref.slice("refs/heads/".length);
  }
  if (ref.startsWith("refs/")) {
    return ref.slice("refs/".length);
  }
  return ref;
}

function mapWorkflowRun(run: GitHubWorkflowRun): RunnerUpgradeWorkflowRun {
  const status =
    run.status === "queued" ||
    run.status === "in_progress" ||
    run.status === "completed"
      ? run.status
      : run.status === "waiting" ||
          run.status === "requested" ||
          run.status === "pending"
        ? "queued"
        : "in_progress";
  const conclusion =
    run.conclusion === "success" ||
    run.conclusion === "failure" ||
    run.conclusion === "cancelled"
      ? run.conclusion
      : run.conclusion === null
        ? null
        : "failure";
  return {
    id: run.id,
    status,
    conclusion,
    htmlUrl: run.html_url,
    createdAt: run.created_at,
    name: run.name,
    displayTitle: run.display_title,
  };
}

function sha256Buffer(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

class LiveRunnerUpgradeProvider implements RunnerUpgradeGitHubProvider {
  private readonly client: GitHubClient;
  private readonly remoteSetup: ReturnType<typeof createLiveGitHubRemoteSetupProvider>;

  constructor(options: GitHubClientOptions) {
    this.client = new GitHubClient(options);
    this.remoteSetup = createLiveGitHubRemoteSetupProvider(options.token);
  }

  async getRepositoryMetadata(
    owner: string,
    repo: string,
    options?: RunnerUpgradeProviderCallOptions,
  ): Promise<RunnerUpgradeRepositoryMetadata | null> {
    try {
      const repository = await this.client.getRepository(owner, repo, {
        signal: options?.signal,
      });
      if (
        typeof repository.id !== "number" ||
        !Number.isInteger(repository.id) ||
        repository.id <= 0
      ) {
        throw new Error(
          `GitHub repository metadata for ${owner}/${repo} is missing a valid numeric repository ID.`,
        );
      }
      return {
        id: repository.id,
        fullName: repository.full_name ?? `${owner}/${repo}`,
        defaultBranch: repository.default_branch ?? "main",
      };
    } catch (error) {
      if (error instanceof GitHubApiError && error.status === 404) {
        return null;
      }
      throw preserveGitHubSetupError(error);
    }
  }

  async getRepositoryMetadataById(
    id: number,
  ): Promise<RunnerUpgradeRepositoryMetadata | null> {
    try {
      const repository = await this.client.getRepositoryById(id);
      const fullName = repository.full_name;
      if (!fullName || !fullName.includes("/")) {
        throw new Error(
          `GitHub repository ID ${id} returned invalid full_name metadata.`,
        );
      }
      const [owner, repo] = fullName.split("/");
      if (!owner || !repo) {
        throw new Error(
          `GitHub repository ID ${id} returned invalid full_name metadata.`,
        );
      }
      return this.getRepositoryMetadata(owner, repo);
    } catch (error) {
      if (error instanceof GitHubApiError && error.status === 404) {
        return null;
      }
      throw preserveGitHubSetupError(error);
    }
  }

  async getRepositoryDefaultBranchHead(
    owner: string,
    repo: string,
    branch: string,
    options?: RunnerUpgradeProviderCallOptions,
  ): Promise<string> {
    try {
      const ref = await this.client.getBranchRef(owner, repo, branch, {
        signal: options?.signal,
      });
      return ref.object.sha;
    } catch (error) {
      throw preserveGitHubSetupError(error);
    }
  }

  async readRepositoryFileContent(
    owner: string,
    repo: string,
    path: string,
    ref: string,
    options?: RunnerUpgradeProviderCallOptions,
  ): Promise<string | null> {
    try {
      const content = await this.client.getRepositoryContent(
        owner,
        repo,
        path,
        ref,
        { signal: options?.signal },
      );
      return content ? this.client.decodeRepositoryContent(content) : null;
    } catch (error) {
      throw preserveGitHubSetupError(error);
    }
  }

  async listRepositoryTreePaths(
    owner: string,
    repo: string,
    ref: string,
  ): Promise<Array<{ path: string; sha: string; type: string }>> {
    try {
      const commit = await this.client.getGitCommit(owner, repo, ref);
      const tree = await this.client.getGitTree({
        owner,
        repo,
        treeSha: commit.tree.sha,
        recursive: true,
      });
      return (tree.tree ?? [])
        .filter((entry) => entry.path && entry.type === "blob")
        .map((entry) => ({
          path: entry.path!,
          sha: entry.sha,
          type: entry.type,
        }));
    } catch (error) {
      throw preserveGitHubSetupError(error);
    }
  }

  async getBlobContentSha256(
    owner: string,
    repo: string,
    blobSha: string,
  ): Promise<string> {
    try {
      const blob = await this.client.getGitBlob(owner, repo, blobSha);
      const content =
        blob.encoding === "base64"
          ? Buffer.from(blob.content, "base64")
          : Buffer.from(blob.content, "utf8");
      return sha256Buffer(content);
    } catch (error) {
      throw preserveGitHubSetupError(error);
    }
  }

  async createGitBlob(input: {
    owner: string;
    repo: string;
    content: Buffer;
  }): Promise<GitBlobResult> {
    try {
      return await this.client.createGitBlob(input);
    } catch (error) {
      throw preserveGitHubSetupError(error);
    }
  }

  async createGitTree(input: {
    owner: string;
    repo: string;
    baseTree?: string;
    tree: GitTreeEntryInput[];
  }): Promise<GitTreeResult> {
    try {
      const tree = await this.client.createGitTree(input);
      return { sha: tree.sha };
    } catch (error) {
      throw preserveGitHubSetupError(error);
    }
  }

  async createGitCommit(input: {
    owner: string;
    repo: string;
    message: string;
    tree: string;
    parents: string[];
    author?: GitCommitIdentity;
    committer?: GitCommitIdentity;
  }): Promise<GitCommitResult> {
    try {
      const commit = await this.client.createGitCommit(input);
      return {
        sha: commit.sha,
        tree: commit.tree,
        parents: commit.parents,
      };
    } catch (error) {
      throw preserveGitHubSetupError(error);
    }
  }

  async getGitCommit(
    owner: string,
    repo: string,
    sha: string,
  ): Promise<GitCommitResult> {
    try {
      const commit = await this.client.getGitCommit(owner, repo, sha);
      return {
        sha: commit.sha,
        tree: commit.tree,
        parents: commit.parents,
      };
    } catch (error) {
      throw preserveGitHubSetupError(error);
    }
  }

  async getGitRef(owner: string, repo: string, ref: string): Promise<GitRefResult> {
    try {
      const gitRef = await this.client.getGitRef(owner, repo, ref);
      return {
        ref: gitRef.ref,
        object: { sha: gitRef.object.sha },
      };
    } catch (error) {
      throw preserveGitHubSetupError(error);
    }
  }

  async updateGitRef(input: {
    owner: string;
    repo: string;
    ref: string;
    sha: string;
    force?: boolean;
    expectedSha?: string;
  }): Promise<GitRefResult> {
    try {
      if (input.expectedSha) {
        const current = await this.getGitRef(input.owner, input.repo, input.ref);
        if (current.object.sha !== input.expectedSha) {
          throw new Error(
            `Ref update rejected: expected ${input.expectedSha}, found ${current.object.sha}.`,
          );
        }
      }
      const gitRef = await this.client.updateGitRef({
        owner: input.owner,
        repo: input.repo,
        ref: input.ref,
        sha: input.sha,
        force: input.force,
      });
      return {
        ref: gitRef.ref,
        object: { sha: gitRef.object.sha },
      };
    } catch (error) {
      throw preserveGitHubSetupError(error);
    }
  }

  async createGitRef(input: {
    owner: string;
    repo: string;
    ref: string;
    sha: string;
  }): Promise<GitRefResult> {
    try {
      const branch = normalizeBranchRef(input.ref);
      const gitRef = await this.client.createGitRef(
        input.owner,
        input.repo,
        branch,
        input.sha,
      );
      return {
        ref: gitRef.ref,
        object: { sha: gitRef.object.sha },
      };
    } catch (error) {
      throw preserveGitHubSetupError(error);
    }
  }

  async listPullRequests(
    owner: string,
    repo: string,
    opts: {
      state?: "open" | "closed" | "all";
      base?: string;
      head?: string;
    },
  ): Promise<RunnerUpgradePullRequest[]> {
    try {
      const pulls = await this.client.listPullRequests(owner, repo, {
        state: opts.state,
        base: opts.base,
        head: opts.head,
      });
      return pulls.map((pull) => ({
        number: pull.number,
        htmlUrl: pull.html_url,
        headRef: pull.head.ref,
        baseRef: pull.base.ref,
        body: pull.body ?? "",
        state: pull.state === "closed" ? "closed" : "open",
        headSha: pull.head.sha,
      }));
    } catch (error) {
      throw preserveGitHubSetupError(error);
    }
  }

  async createPullRequest(input: {
    owner: string;
    repo: string;
    title: string;
    head: string;
    base: string;
    body: string;
  }): Promise<{ number: number; htmlUrl: string }> {
    try {
      const created = await this.client.createPullRequest(input);
      return { number: created.number, htmlUrl: created.html_url };
    } catch (error) {
      throw preserveGitHubSetupError(error);
    }
  }

  async updatePullRequest(
    owner: string,
    repo: string,
    number: number,
    patch: { body?: string; title?: string },
  ): Promise<void> {
    try {
      await this.client.updatePullRequest(owner, repo, number, patch);
    } catch (error) {
      throw preserveGitHubSetupError(error);
    }
  }

  async mergePullRequest(
    owner: string,
    repo: string,
    number: number,
    options: {
      mergeMethod?: "squash" | "merge" | "rebase";
      commitTitle?: string;
      expectedHeadSha?: string;
    },
  ): Promise<void> {
    try {
      await this.client.mergePullRequest(owner, repo, number, {
        mergeMethod: options.mergeMethod ?? "squash",
        commitTitle: options.commitTitle,
        expectedHeadSha: options.expectedHeadSha,
      });
    } catch (error) {
      throw preserveGitHubSetupError(error);
    }
  }

  async dispatchWorkflow(
    owner: string,
    repo: string,
    workflowIdOrPath: string,
    ref: string,
    inputs?: Record<string, string>,
  ): Promise<{ runId?: number }> {
    try {
      // GitHub returns 204 No Content — never rely on a run id in the body.
      await this.client.createWorkflowDispatch(
        owner,
        repo,
        workflowIdOrPath,
        ref,
        inputs,
      );
      return {};
    } catch (error) {
      throw preserveGitHubSetupError(error);
    }
  }

  async getWorkflowRun(
    owner: string,
    repo: string,
    runId: number,
  ): Promise<RunnerUpgradeWorkflowRun> {
    try {
      const run = await this.client.getWorkflowRun(owner, repo, runId);
      return mapWorkflowRun(run);
    } catch (error) {
      throw preserveGitHubSetupError(error);
    }
  }

  async listWorkflowRuns(
    owner: string,
    repo: string,
    workflowIdOrPath: string,
    opts?: { branch?: string; event?: string },
  ): Promise<RunnerUpgradeWorkflowRun[]> {
    try {
      const runs = await this.client.listWorkflowRuns(
        owner,
        repo,
        workflowIdOrPath,
        {
          branch: opts?.branch,
          event: opts?.event,
        },
      );
      return runs.map(mapWorkflowRun);
    } catch (error) {
      throw preserveGitHubSetupError(error);
    }
  }

  async writeHarnessSecrets(
    repo: string,
    secrets: HarnessSecretWriteRequest[],
  ): Promise<HarnessSecretWriteResultEntry[]> {
    if (!this.remoteSetup.writeHarnessSecrets) {
      throw new Error("Live remote setup provider does not support writeHarnessSecrets.");
    }
    return this.remoteSetup.writeHarnessSecrets(repo, secrets);
  }

  async writeHarnessVariables(
    repo: string,
    variables: HarnessVariableWriteRequest[],
  ): Promise<HarnessVariableWriteResultEntry[]> {
    if (!this.remoteSetup.writeHarnessVariables) {
      throw new Error(
        "Live remote setup provider does not support writeHarnessVariables.",
      );
    }
    return this.remoteSetup.writeHarnessVariables(repo, variables);
  }
}

export function createLiveRunnerUpgradeProvider(
  token: string,
  options?: { timeoutMs?: number },
): RunnerUpgradeGitHubProvider {
  return new LiveRunnerUpgradeProvider({
    token,
    timeoutMs: options?.timeoutMs,
  });
}
