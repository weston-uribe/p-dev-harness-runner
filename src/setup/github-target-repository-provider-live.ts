import { GitHubApiError, GitHubClient } from "../github/client.js";
import type {
  AuthenticatedGitHubUser,
  CreateUserRepositoryResult,
  GitHubRepositoryMetadata,
  GitHubTokenCapabilitySummary,
  GitRefResult,
  GitTreeEntryInput,
} from "./github-remote-provider.js";
import {
  assessPackagedProvisioningTokenCapabilities,
  classicPatHasRepoScope,
  classicPatHasWorkflowScope,
  resolveGitHubTokenType,
} from "./github-workflow-permissions.js";
import type {
  BootstrapCommitFile,
  CreateTargetRepositoryInput,
  GitHubTargetRepositoryProvider,
} from "./github-target-repository-provider.js";
import { isGitHubNotFoundError } from "./github-target-repository-provider.js";
import type { RemoteAccessStatus } from "./remote-actions.js";

function preserveGitHubSetupError(error: unknown): Error {
  if (error instanceof GitHubApiError) {
    return error;
  }
  if (error instanceof Error) {
    return error;
  }
  return new Error(String(error));
}

function mapRepositoryToMetadata(
  owner: string,
  repo: string,
  repository: import("../github/client.js").GitHubRepository,
): GitHubRepositoryMetadata {
  if (repository.id === undefined) {
    throw new Error(`GitHub repository ${owner}/${repo} returned no repository ID.`);
  }
  return {
    repositoryId: repository.id,
    owner,
    repo,
    description: repository.description ?? null,
    private: repository.private ?? false,
    visibility: repository.visibility ?? (repository.private ? "private" : "public"),
    isTemplate: repository.is_template ?? false,
    defaultBranch: repository.default_branch ?? "main",
    permissions: {
      admin: repository.permissions?.admin ?? false,
      maintain: repository.permissions?.maintain ?? false,
      push: repository.permissions?.push ?? false,
    },
  };
}

export class LiveGitHubTargetRepositoryProvider
  implements GitHubTargetRepositoryProvider
{
  constructor(private readonly client: GitHubClient) {}

  async resolveAuthenticatedUser(): Promise<AuthenticatedGitHubUser> {
    const user = await this.client.getAuthenticatedUser();
    return { id: user.id, login: user.login };
  }

  async inspectTokenCapabilities(): Promise<GitHubTokenCapabilitySummary> {
    const inspected = await this.client.inspectAuthenticatedUser();
    const tokenType = resolveGitHubTokenType(
      inspected.tokenType,
      inspected.oauthScopes,
    );
    const metadata = {
      login: inspected.login,
      tokenType,
      oauthScopes: inspected.oauthScopes,
      hasWorkflowScope: classicPatHasWorkflowScope(inspected.oauthScopes),
      hasRepoScope: classicPatHasRepoScope(inspected.oauthScopes),
    };
    const scopeAmbiguous =
      tokenType === "classic" && metadata.oauthScopes.length === 0;
    const assessment = assessPackagedProvisioningTokenCapabilities(metadata);
    if (!assessment.ok) {
      return {
        login: inspected.login,
        tokenType,
        hasRepoScope: false,
        hasWorkflowScope: false,
        scopeAmbiguous,
      };
    }
    return {
      login: inspected.login,
      tokenType,
      hasRepoScope: metadata.hasRepoScope,
      hasWorkflowScope: metadata.hasWorkflowScope,
      scopeAmbiguous,
    };
  }

  async checkRepositoryAvailability(
    owner: string,
    name: string,
  ): Promise<"available" | "repository_already_exists" | "forbidden"> {
    try {
      const metadata = await this.getRepositoryMetadata(owner, name);
      return metadata ? "repository_already_exists" : "available";
    } catch (error) {
      if (error instanceof GitHubApiError && error.status === 403) {
        return "forbidden";
      }
      throw preserveGitHubSetupError(error);
    }
  }

  async createPersonalRepository(
    input: CreateTargetRepositoryInput,
  ): Promise<CreateUserRepositoryResult> {
    try {
      const created = await this.client.createUserRepository({
        name: input.name,
        description: input.description ?? "",
        private: input.visibility === "private",
        autoInit: true,
      });
      return {
        repositoryId: created.id,
        fullName: created.full_name,
        defaultBranch: created.default_branch,
      };
    } catch (error) {
      throw preserveGitHubSetupError(error);
    }
  }

  async getRepositoryMetadata(
    owner: string,
    repo: string,
  ): Promise<GitHubRepositoryMetadata | null> {
    try {
      const repository = await this.client.getRepository(owner, repo);
      return mapRepositoryToMetadata(owner, repo, repository);
    } catch (error) {
      if (isGitHubNotFoundError(error)) {
        return null;
      }
      throw preserveGitHubSetupError(error);
    }
  }

  async getRepositoryDefaultBranchHead(
    owner: string,
    repo: string,
    branch: string,
  ): Promise<string> {
    const ref = await this.client.getBranchRef(owner, repo, branch);
    return ref.object.sha;
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

  async createGitRef(
    owner: string,
    repo: string,
    branch: string,
    sha: string,
  ): Promise<GitRefResult> {
    try {
      const created = await this.client.createGitRef(owner, repo, branch, sha);
      return {
        ref: created.ref,
        object: { sha: created.object.sha },
      };
    } catch (error) {
      throw preserveGitHubSetupError(error);
    }
  }

  async writeBootstrapCommit(input: {
    owner: string;
    repo: string;
    branch: string;
    parentSha: string;
    files: BootstrapCommitFile[];
    message: string;
  }): Promise<{ commitSha: string }> {
    try {
      const parentCommit = await this.client.getGitCommit(
        input.owner,
        input.repo,
        input.parentSha,
      );
      const treeEntries: GitTreeEntryInput[] = [];
      for (const file of input.files) {
        const blob = await this.client.createGitBlob({
          owner: input.owner,
          repo: input.repo,
          content: Buffer.from(file.content, "utf8"),
        });
        treeEntries.push({
          path: file.path,
          mode: "100644",
          type: "blob",
          sha: blob.sha,
        });
      }
      const tree = await this.client.createGitTree({
        owner: input.owner,
        repo: input.repo,
        baseTree: parentCommit.tree.sha,
        tree: treeEntries,
      });
      const commit = await this.client.createGitCommit({
        owner: input.owner,
        repo: input.repo,
        message: input.message,
        tree: tree.sha,
        parents: [input.parentSha],
      });
      const currentRef = await this.client.getGitRef(
        input.owner,
        input.repo,
        `heads/${input.branch}`,
      );
      if (currentRef.object.sha !== input.parentSha) {
        throw new Error(
          `Bootstrap ref update rejected: expected parent ${input.parentSha}, found ${currentRef.object.sha}.`,
        );
      }
      await this.client.updateGitRef({
        owner: input.owner,
        repo: input.repo,
        ref: `heads/${input.branch}`,
        sha: commit.sha,
      });
      return { commitSha: commit.sha };
    } catch (error) {
      throw preserveGitHubSetupError(error);
    }
  }

  async verifyRepositoryAccess(
    owner: string,
    repo: string,
  ): Promise<RemoteAccessStatus> {
    const metadata = await this.getRepositoryMetadata(owner, repo);
    if (!metadata) {
      return "unknown";
    }
    if (!metadata.permissions.push) {
      return "denied";
    }
    return "available";
  }

  async ensureDefaultBranch(
    owner: string,
    repo: string,
    branchName: string,
  ): Promise<{ defaultBranch: string; corrected: boolean }> {
    const metadata = await this.getRepositoryMetadata(owner, repo);
    if (!metadata) {
      throw new Error(`Repository ${owner}/${repo} was not found.`);
    }
    if (metadata.defaultBranch === branchName) {
      return { defaultBranch: metadata.defaultBranch, corrected: false };
    }
    await this.client.updateUserRepository({
      owner,
      repo,
      default_branch: branchName,
    });
    const updated = await this.getRepositoryMetadata(owner, repo);
    return {
      defaultBranch: updated?.defaultBranch ?? branchName,
      corrected: true,
    };
  }

  async verifyBranchExists(
    owner: string,
    repo: string,
    branch: string,
  ): Promise<boolean> {
    try {
      await this.getGitRef(owner, repo, branch);
      return true;
    } catch (error) {
      if (isGitHubNotFoundError(error)) {
        return false;
      }
      throw preserveGitHubSetupError(error);
    }
  }

  async readRepositoryFileContent(
    owner: string,
    repo: string,
    path: string,
    ref: string,
  ): Promise<string | null> {
    const content = await this.client.getRepositoryContent(owner, repo, path, ref);
    return content ? this.client.decodeRepositoryContent(content) : null;
  }
}

export function createLiveGitHubTargetRepositoryProvider(
  token: string,
): LiveGitHubTargetRepositoryProvider {
  return new LiveGitHubTargetRepositoryProvider(new GitHubClient({ token }));
}
