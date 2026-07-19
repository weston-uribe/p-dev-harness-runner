import { createHash } from "node:crypto";
import { GitHubApiError } from "../github/client.js";
import type {
  AuthenticatedGitHubUser,
  CreateUserRepositoryResult,
  GitHubRepositoryMetadata,
  GitHubTokenCapabilitySummary,
  GitRefResult,
} from "./github-remote-provider.js";
import {
  createMockGitRepositoryStore,
  type MockGitRepositoryStore,
} from "./mock-git-repository-store.js";
import type {
  BootstrapCommitFile,
  CreateTargetRepositoryInput,
  GitHubTargetRepositoryProvider,
} from "./github-target-repository-provider.js";
import type { RemoteAccessStatus } from "./remote-actions.js";

export function deterministicTargetMockRepositoryId(fullName: string): number {
  const hash = createHash("sha256").update(fullName).digest();
  return hash.readUInt32BE(0);
}

interface MockRepositoryRecord {
  owner: string;
  repo: string;
  repositoryId: number;
  description: string;
  private: boolean;
  defaultBranch: string;
  store: MockGitRepositoryStore;
  branchHeads: Map<string, string>;
}

export interface MockTargetRepositoryProviderState {
  authenticatedLogin?: string;
  createdRepositoryDefaultBranch?: string;
  forbidCreate?: boolean;
}

export class MockGitHubTargetRepositoryProvider
  implements GitHubTargetRepositoryProvider
{
  readonly calls: Array<{ method: string; args: unknown[] }> = [];
  private readonly repositories = new Map<string, MockRepositoryRecord>();
  private state: MockTargetRepositoryProviderState;

  constructor(state: MockTargetRepositoryProviderState = {}) {
    this.state = state;
  }

  setState(state: MockTargetRepositoryProviderState): void {
    this.state = state;
  }

  private repoKey(owner: string, repo: string): string {
    return `${owner}/${repo}`;
  }

  private requireRepo(owner: string, repo: string): MockRepositoryRecord {
    const record = this.repositories.get(this.repoKey(owner, repo));
    if (!record) {
      throw new GitHubApiError(404, `Repository ${owner}/${repo} not found.`);
    }
    return record;
  }

  async resolveAuthenticatedUser(): Promise<AuthenticatedGitHubUser> {
    this.calls.push({ method: "resolveAuthenticatedUser", args: [] });
    const login = this.state.authenticatedLogin ?? "test-user";
    return { id: 1, login };
  }

  async inspectTokenCapabilities(): Promise<GitHubTokenCapabilitySummary> {
    this.calls.push({ method: "inspectTokenCapabilities", args: [] });
    const login = this.state.authenticatedLogin ?? "test-user";
    return {
      login,
      tokenType: "classic",
      hasRepoScope: true,
      hasWorkflowScope: true,
      scopeAmbiguous: false,
    };
  }

  async checkRepositoryAvailability(
    owner: string,
    name: string,
  ): Promise<"available" | "repository_already_exists" | "forbidden"> {
    this.calls.push({ method: "checkRepositoryAvailability", args: [owner, name] });
    return this.repositories.has(this.repoKey(owner, name))
      ? "repository_already_exists"
      : "available";
  }

  async createPersonalRepository(
    input: CreateTargetRepositoryInput,
  ): Promise<CreateUserRepositoryResult> {
    this.calls.push({ method: "createPersonalRepository", args: [input] });
    if (this.state.forbidCreate) {
      throw new GitHubApiError(403, "Repository creation forbidden.");
    }
    const key = this.repoKey(input.owner, input.name);
    if (this.repositories.has(key)) {
      throw new GitHubApiError(422, "Repository already exists.");
    }
    const store = await createMockGitRepositoryStore();
    const defaultBranch = this.state.createdRepositoryDefaultBranch ?? "main";
    const headSha = store.getHeadSha();
    const repositoryId = deterministicTargetMockRepositoryId(key);
    this.repositories.set(key, {
      owner: input.owner,
      repo: input.name,
      repositoryId,
      description: input.description ?? "",
      private: input.visibility === "private",
      defaultBranch,
      store,
      branchHeads: new Map([[defaultBranch, headSha]]),
    });
    return {
      repositoryId,
      fullName: key,
      defaultBranch,
    };
  }

  async getRepositoryMetadata(
    owner: string,
    repo: string,
  ): Promise<GitHubRepositoryMetadata | null> {
    this.calls.push({ method: "getRepositoryMetadata", args: [owner, repo] });
    const record = this.repositories.get(this.repoKey(owner, repo));
    if (!record) {
      return null;
    }
    return {
      repositoryId: record.repositoryId,
      owner: record.owner,
      repo: record.repo,
      description: record.description,
      private: record.private,
      visibility: record.private ? "private" : "public",
      isTemplate: false,
      defaultBranch: record.defaultBranch,
      permissions: { admin: true, maintain: true, push: true },
    };
  }

  async getRepositoryDefaultBranchHead(
    owner: string,
    repo: string,
    branch: string,
  ): Promise<string> {
    this.calls.push({
      method: "getRepositoryDefaultBranchHead",
      args: [owner, repo, branch],
    });
    const record = this.requireRepo(owner, repo);
    const head = record.branchHeads.get(branch);
    if (!head) {
      throw new GitHubApiError(404, `Branch ${branch} not found.`);
    }
    return head;
  }

  async getGitRef(owner: string, repo: string, ref: string): Promise<GitRefResult> {
    this.calls.push({ method: "getGitRef", args: [owner, repo, ref] });
    const record = this.requireRepo(owner, repo);
    const head = record.branchHeads.get(ref);
    if (!head) {
      throw new GitHubApiError(404, `Branch ${ref} not found.`);
    }
    return {
      ref: `refs/heads/${ref}`,
      object: { sha: head },
    };
  }

  async createGitRef(
    owner: string,
    repo: string,
    branch: string,
    sha: string,
  ): Promise<GitRefResult> {
    this.calls.push({ method: "createGitRef", args: [owner, repo, branch, sha] });
    const record = this.requireRepo(owner, repo);
    if (record.branchHeads.has(branch)) {
      throw new GitHubApiError(422, `Branch ${branch} already exists.`);
    }
    record.branchHeads.set(branch, sha);
    return {
      ref: `refs/heads/${branch}`,
      object: { sha },
    };
  }

  async writeBootstrapCommit(input: {
    owner: string;
    repo: string;
    branch: string;
    parentSha: string;
    files: BootstrapCommitFile[];
    message: string;
  }): Promise<{ commitSha: string }> {
    this.calls.push({ method: "writeBootstrapCommit", args: [input] });
    const record = this.requireRepo(input.owner, input.repo);
    const currentHead = record.branchHeads.get(input.branch);
    if (!currentHead || currentHead !== input.parentSha) {
      throw new Error(
        `Bootstrap ref update rejected: expected parent ${input.parentSha}, found ${currentHead ?? "missing"}.`,
      );
    }
    const treeEntries = input.files.map((file) => {
      const sha = record.store.createBlob(Buffer.from(file.content, "utf8"));
      return { path: file.path, mode: "100644", sha };
    });
    const parentCommit = record.store.getCommit(input.parentSha);
    if (!parentCommit) {
      throw new Error(`Parent commit ${input.parentSha} not found.`);
    }
    const treeSha = record.store.createTreeWithBase(treeEntries, parentCommit.treeSha);
    const commitSha = record.store.createCommitRecord({
      message: input.message,
      treeSha,
      parents: [input.parentSha],
    });
    record.store.updateRef(commitSha, input.parentSha);
    record.branchHeads.set(input.branch, commitSha);
    return { commitSha };
  }

  async verifyRepositoryAccess(
    owner: string,
    repo: string,
  ): Promise<RemoteAccessStatus> {
    this.calls.push({ method: "verifyRepositoryAccess", args: [owner, repo] });
    const metadata = await this.getRepositoryMetadata(owner, repo);
    return metadata ? "available" : "unknown";
  }

  async ensureDefaultBranch(
    owner: string,
    repo: string,
    branchName: string,
  ): Promise<{ defaultBranch: string; corrected: boolean }> {
    this.calls.push({ method: "ensureDefaultBranch", args: [owner, repo, branchName] });
    const record = this.requireRepo(owner, repo);
    const corrected = record.defaultBranch !== branchName;
    record.defaultBranch = branchName;
    return { defaultBranch: branchName, corrected };
  }

  async verifyBranchExists(
    owner: string,
    repo: string,
    branch: string,
  ): Promise<boolean> {
    this.calls.push({ method: "verifyBranchExists", args: [owner, repo, branch] });
    const record = this.repositories.get(this.repoKey(owner, repo));
    return Boolean(record?.branchHeads.has(branch));
  }

  async readRepositoryFileContent(
    owner: string,
    repo: string,
    path: string,
    ref: string,
  ): Promise<string | null> {
    this.calls.push({
      method: "readRepositoryFileContent",
      args: [owner, repo, path, ref],
    });
    const record = this.requireRepo(owner, repo);
    const headSha = record.branchHeads.get(ref);
    if (!headSha) {
      return null;
    }
    const content = record.store.readFileAtCommit(headSha, path);
    return content ? content.toString("utf8") : null;
  }
}
