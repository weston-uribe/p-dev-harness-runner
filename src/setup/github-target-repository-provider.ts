import { GitHubApiError } from "../github/client.js";
import type {
  AuthenticatedGitHubUser,
  CreateUserRepositoryInput,
  CreateUserRepositoryResult,
  GitHubRepositoryMetadata,
  GitHubTokenCapabilitySummary,
  GitRefResult,
} from "./github-remote-provider.js";
import type { RemoteAccessStatus } from "./remote-actions.js";

export interface CreateTargetRepositoryInput {
  owner: string;
  name: string;
  description?: string;
  visibility: "private" | "public";
}

export interface BootstrapCommitFile {
  path: string;
  content: string;
}

export interface GitHubTargetRepositoryProvider {
  resolveAuthenticatedUser(): Promise<AuthenticatedGitHubUser>;
  inspectTokenCapabilities(): Promise<GitHubTokenCapabilitySummary>;
  checkRepositoryAvailability(
    owner: string,
    name: string,
  ): Promise<"available" | "repository_already_exists" | "forbidden">;
  createPersonalRepository(
    input: CreateTargetRepositoryInput,
  ): Promise<CreateUserRepositoryResult>;
  getRepositoryMetadata(
    owner: string,
    repo: string,
  ): Promise<GitHubRepositoryMetadata | null>;
  getRepositoryDefaultBranchHead(
    owner: string,
    repo: string,
    branch: string,
  ): Promise<string>;
  getGitRef(owner: string, repo: string, ref: string): Promise<GitRefResult>;
  createGitRef(
    owner: string,
    repo: string,
    branch: string,
    sha: string,
  ): Promise<GitRefResult>;
  writeBootstrapCommit(input: {
    owner: string;
    repo: string;
    branch: string;
    parentSha: string;
    files: BootstrapCommitFile[];
    message: string;
  }): Promise<{ commitSha: string }>;
  verifyRepositoryAccess(owner: string, repo: string): Promise<RemoteAccessStatus>;
  ensureDefaultBranch(
    owner: string,
    repo: string,
    branchName: string,
  ): Promise<{ defaultBranch: string; corrected: boolean }>;
  verifyBranchExists(owner: string, repo: string, branch: string): Promise<boolean>;
  readRepositoryFileContent(
    owner: string,
    repo: string,
    path: string,
    ref: string,
  ): Promise<string | null>;
}

export type { CreateUserRepositoryInput, CreateUserRepositoryResult };

export {
  LiveGitHubTargetRepositoryProvider,
  createLiveGitHubTargetRepositoryProvider,
} from "./github-target-repository-provider-live.js";
export {
  MockGitHubTargetRepositoryProvider,
  deterministicTargetMockRepositoryId,
} from "./github-target-repository-provider-mock.js";

export function isGitHubNotFoundError(error: unknown): boolean {
  return error instanceof GitHubApiError && error.status === 404;
}
