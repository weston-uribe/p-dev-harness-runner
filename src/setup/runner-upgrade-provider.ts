import { createHash } from "node:crypto";
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
import {
  createMockGitRepositoryStore,
  type MockGitRepositoryStore,
} from "./mock-git-repository-store.js";
import { HARNESS_MANAGED_REPO_MARKER_FILE } from "./harness-managed-repo-marker.js";

export interface RunnerUpgradeRepositoryMetadata {
  id: number;
  fullName: string;
  defaultBranch: string;
}

export interface RunnerUpgradePullRequest {
  number: number;
  htmlUrl: string;
  headRef: string;
  baseRef: string;
  body: string;
  state: "open" | "closed";
  headSha: string;
}

export interface RunnerUpgradeWorkflowRun {
  id: number;
  status: "queued" | "in_progress" | "completed";
  conclusion: "success" | "failure" | "cancelled" | null;
  htmlUrl: string;
  createdAt: string;
  /** Workflow run name / run-name (used to locate canary after 204 dispatch). */
  name?: string;
  displayTitle?: string;
}

export interface RunnerUpgradeProviderCallOptions {
  signal?: AbortSignal;
}

export interface RunnerUpgradeGitHubProvider {
  getRepositoryMetadata(
    owner: string,
    repo: string,
    options?: RunnerUpgradeProviderCallOptions,
  ): Promise<RunnerUpgradeRepositoryMetadata | null>;
  getRepositoryMetadataById?(
    id: number,
    options?: RunnerUpgradeProviderCallOptions,
  ): Promise<RunnerUpgradeRepositoryMetadata | null>;
  getRepositoryDefaultBranchHead(
    owner: string,
    repo: string,
    branch: string,
    options?: RunnerUpgradeProviderCallOptions,
  ): Promise<string>;
  readRepositoryFileContent(
    owner: string,
    repo: string,
    path: string,
    ref: string,
    options?: RunnerUpgradeProviderCallOptions,
  ): Promise<string | null>;
  listRepositoryTreePaths?(
    owner: string,
    repo: string,
    ref: string,
  ): Promise<Array<{ path: string; sha: string; type: string }>>;
  getBlobContentSha256?(
    owner: string,
    repo: string,
    blobSha: string,
  ): Promise<string>;
  createGitBlob(input: {
    owner: string;
    repo: string;
    content: Buffer;
  }): Promise<GitBlobResult>;
  createGitTree(input: {
    owner: string;
    repo: string;
    baseTree?: string;
    tree: GitTreeEntryInput[];
  }): Promise<GitTreeResult>;
  createGitCommit(input: {
    owner: string;
    repo: string;
    message: string;
    tree: string;
    parents: string[];
    author?: GitCommitIdentity;
    committer?: GitCommitIdentity;
  }): Promise<GitCommitResult>;
  getGitCommit(
    owner: string,
    repo: string,
    sha: string,
  ): Promise<GitCommitResult>;
  getGitRef(owner: string, repo: string, ref: string): Promise<GitRefResult>;
  updateGitRef(input: {
    owner: string;
    repo: string;
    ref: string;
    sha: string;
    force?: boolean;
    expectedSha?: string;
  }): Promise<GitRefResult>;
  createGitRef?(input: {
    owner: string;
    repo: string;
    ref: string;
    sha: string;
  }): Promise<GitRefResult>;
  listPullRequests(
    owner: string,
    repo: string,
    opts: {
      state?: "open" | "closed" | "all";
      base?: string;
      head?: string;
    },
  ): Promise<RunnerUpgradePullRequest[]>;
  createPullRequest(input: {
    owner: string;
    repo: string;
    title: string;
    head: string;
    base: string;
    body: string;
  }): Promise<{ number: number; htmlUrl: string }>;
  updatePullRequest?(
    owner: string,
    repo: string,
    number: number,
    patch: { body?: string; title?: string },
  ): Promise<void>;
  mergePullRequest(
    owner: string,
    repo: string,
    number: number,
    options: {
      mergeMethod?: "squash" | "merge" | "rebase";
      commitTitle?: string;
      expectedHeadSha?: string;
    },
  ): Promise<void>;
  dispatchWorkflow(
    owner: string,
    repo: string,
    workflowIdOrPath: string,
    ref: string,
    inputs?: Record<string, string>,
  ): Promise<{ runId?: number }>;
  getWorkflowRun(
    owner: string,
    repo: string,
    runId: number,
  ): Promise<RunnerUpgradeWorkflowRun>;
  listWorkflowRuns(
    owner: string,
    repo: string,
    workflowIdOrPath: string,
    opts?: { branch?: string; event?: string },
  ): Promise<RunnerUpgradeWorkflowRun[]>;
  writeHarnessSecrets?(
    repo: string,
    secrets: HarnessSecretWriteRequest[],
  ): Promise<HarnessSecretWriteResultEntry[]>;
  writeHarnessVariables?(
    repo: string,
    variables: HarnessVariableWriteRequest[],
  ): Promise<HarnessVariableWriteResultEntry[]>;
}

export interface MockRunnerUpgradeRepositoryState {
  repositoryId: number;
  owner: string;
  repo: string;
  defaultBranch?: string;
  managedMarkerContent?: string | null;
  remoteFiles?: Record<string, string>;
  pullRequests?: RunnerUpgradePullRequest[];
  workflowRuns?: RunnerUpgradeWorkflowRun[];
}

export interface MockRunnerUpgradeProviderState {
  repositories?: Record<string, MockRunnerUpgradeRepositoryState>;
  canaryConclusion?: "success" | "failure";
  syncShouldFail?: boolean;
}

interface MutableRepositoryState {
  metadata: RunnerUpgradeRepositoryMetadata & { owner: string; repo: string };
  store: MockGitRepositoryStore;
  branchHeads: Map<string, string>;
  pullRequests: RunnerUpgradePullRequest[];
  workflowRuns: RunnerUpgradeWorkflowRun[];
  nextPrNumber: number;
  nextWorkflowRunId: number;
  remoteFiles: Map<string, string>;
}

function repoKey(owner: string, repo: string): string {
  return `${owner}/${repo}`;
}

function sha256Buffer(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function normalizeRef(ref: string): string {
  if (ref.startsWith("refs/heads/")) {
    return ref.slice("refs/heads/".length);
  }
  return ref;
}

export class MockRunnerUpgradeProvider implements RunnerUpgradeGitHubProvider {
  readonly calls: Array<{ method: string; args: unknown[] }> = [];
  readonly remoteWriteOrder: Array<"secret" | "variable"> = [];
  private readonly repositories = new Map<string, MutableRepositoryState>();
  canaryConclusion: "success" | "failure";
  syncShouldFail: boolean;
  /** Artificial delay applied before each provider method (for hang tests). */
  delayMs = 0;
  /** Per-method delay overrides (e.g. readRepositoryFileContent). */
  methodDelayMs: Partial<Record<string, number>> = {};

  private constructor(state: MockRunnerUpgradeProviderState = {}) {
    this.canaryConclusion = state.canaryConclusion ?? "success";
    this.syncShouldFail = state.syncShouldFail ?? false;
  }

  private async maybeDelay(
    method: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const delay = this.methodDelayMs[method] ?? this.delayMs;
    if (delay <= 0) {
      if (signal?.aborted) {
        throw new Error(`${method} aborted.`);
      }
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, delay);
      const onAbort = () => {
        clearTimeout(timer);
        reject(new Error(`${method} aborted.`));
      };
      if (signal?.aborted) {
        clearTimeout(timer);
        reject(new Error(`${method} aborted.`));
        return;
      }
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  static async create(
    state: MockRunnerUpgradeProviderState = {},
  ): Promise<MockRunnerUpgradeProvider> {
    const provider = new MockRunnerUpgradeProvider(state);
    for (const [slug, repoState] of Object.entries(state.repositories ?? {})) {
      await provider.seedRepository(slug, repoState);
    }
    return provider;
  }

  private async seedRepository(
    slug: string,
    repoState: MockRunnerUpgradeRepositoryState,
  ): Promise<void> {
    const [owner, repo] = slug.includes("/")
      ? slug.split("/")
      : [repoState.owner, repoState.repo];
    const defaultBranch = repoState.defaultBranch ?? "main";
    const store = await createMockGitRepositoryStore();
    const remoteFiles = new Map(Object.entries(repoState.remoteFiles ?? {}));
    if (
      repoState.managedMarkerContent &&
      !remoteFiles.has(HARNESS_MANAGED_REPO_MARKER_FILE)
    ) {
      remoteFiles.set(HARNESS_MANAGED_REPO_MARKER_FILE, repoState.managedMarkerContent);
    }
    const entries: Array<{ path: string; mode: string; sha: string }> = [];
    for (const [path, content] of remoteFiles.entries()) {
      const blobSha = store.createBlob(Buffer.from(content, "utf8"));
      entries.push({ path, mode: "100644", sha: blobSha });
    }
    const treeSha = store.createTreeFromFlatEntries(entries);
    const commitSha = store.createCommitRecord({
      message: "Seed managed runner repository",
      treeSha,
      parents: [],
    });
    store.updateRef(commitSha);
    const branchHeads = new Map<string, string>([[defaultBranch, commitSha]]);
    this.repositories.set(repoKey(owner, repo), {
      metadata: {
        id: repoState.repositoryId,
        fullName: `${owner}/${repo}`,
        defaultBranch,
        owner,
        repo,
      },
      store,
      branchHeads,
      pullRequests: [...(repoState.pullRequests ?? [])],
      workflowRuns: [...(repoState.workflowRuns ?? [])],
      nextPrNumber:
        (repoState.pullRequests ?? []).reduce(
          (max, pr) => Math.max(max, pr.number),
          0,
        ) + 1,
      nextWorkflowRunId:
        (repoState.workflowRuns ?? []).reduce(
          (max, run) => Math.max(max, run.id),
          0,
        ) + 1,
      remoteFiles,
    });
  }

  private requireRepo(owner: string, repo: string): MutableRepositoryState {
    const entry = this.repositories.get(repoKey(owner, repo));
    if (!entry) {
      throw new Error(`Mock runner upgrade repository ${owner}/${repo} is not configured.`);
    }
    return entry;
  }

  private resolveBranchHead(
    entry: MutableRepositoryState,
    branch: string,
  ): string {
    const head = entry.branchHeads.get(branch);
    if (!head) {
      throw new Error(`Mock branch ${branch} does not exist.`);
    }
    return head;
  }

  async getRepositoryMetadata(
    owner: string,
    repo: string,
    options?: RunnerUpgradeProviderCallOptions,
  ): Promise<RunnerUpgradeRepositoryMetadata | null> {
    await this.maybeDelay("getRepositoryMetadata", options?.signal);
    this.calls.push({ method: "getRepositoryMetadata", args: [owner, repo] });
    const entry = this.repositories.get(repoKey(owner, repo));
    if (!entry) {
      return null;
    }
    return {
      id: entry.metadata.id,
      fullName: entry.metadata.fullName,
      defaultBranch: entry.metadata.defaultBranch,
    };
  }

  async getRepositoryMetadataById(
    id: number,
    options?: RunnerUpgradeProviderCallOptions,
  ): Promise<RunnerUpgradeRepositoryMetadata | null> {
    await this.maybeDelay("getRepositoryMetadataById", options?.signal);
    this.calls.push({ method: "getRepositoryMetadataById", args: [id] });
    for (const entry of this.repositories.values()) {
      if (entry.metadata.id === id) {
        return {
          id: entry.metadata.id,
          fullName: entry.metadata.fullName,
          defaultBranch: entry.metadata.defaultBranch,
        };
      }
    }
    return null;
  }

  async getRepositoryDefaultBranchHead(
    owner: string,
    repo: string,
    branch: string,
    options?: RunnerUpgradeProviderCallOptions,
  ): Promise<string> {
    await this.maybeDelay("getRepositoryDefaultBranchHead", options?.signal);
    this.calls.push({
      method: "getRepositoryDefaultBranchHead",
      args: [owner, repo, branch],
    });
    return this.resolveBranchHead(this.requireRepo(owner, repo), branch);
  }

  async readRepositoryFileContent(
    owner: string,
    repo: string,
    path: string,
    ref: string,
    options?: RunnerUpgradeProviderCallOptions,
  ): Promise<string | null> {
    await this.maybeDelay("readRepositoryFileContent", options?.signal);
    this.calls.push({
      method: "readRepositoryFileContent",
      args: [owner, repo, path, ref],
    });
    const entry = this.requireRepo(owner, repo);
    const commitSha = entry.branchHeads.get(ref) ?? ref;
    const content = entry.store.readFileAtCommit(commitSha, path);
    return content ? content.toString("utf8") : null;
  }

  async listRepositoryTreePaths(
    owner: string,
    repo: string,
    ref: string,
  ): Promise<Array<{ path: string; sha: string; type: string }>> {
    this.calls.push({
      method: "listRepositoryTreePaths",
      args: [owner, repo, ref],
    });
    const entry = this.requireRepo(owner, repo);
    const commitSha = entry.branchHeads.get(ref) ?? ref;
    const commit = entry.store.getCommit(commitSha);
    if (!commit) {
      return [];
    }
    const paths: Array<{ path: string; sha: string; type: string }> = [];
    for (const [path] of entry.remoteFiles.entries()) {
      const content = entry.store.readFileAtCommit(commitSha, path);
      if (content) {
        paths.push({
          path,
          sha: entry.store.createBlob(content),
          type: "blob",
        });
      }
    }
    return paths;
  }

  async getBlobContentSha256(
    _owner: string,
    _repo: string,
    blobSha: string,
  ): Promise<string> {
    this.calls.push({ method: "getBlobContentSha256", args: [blobSha] });
    const entry = [...this.repositories.values()][0];
    if (!entry) {
      throw new Error("No mock repository configured.");
    }
    const content = entry.store.getBlob(blobSha);
    if (!content) {
      throw new Error(`Mock blob ${blobSha} not found.`);
    }
    return sha256Buffer(content);
  }

  async createGitBlob(input: {
    owner: string;
    repo: string;
    content: Buffer;
  }): Promise<GitBlobResult> {
    this.calls.push({ method: "createGitBlob", args: [input.owner, input.repo] });
    const sha = this.requireRepo(input.owner, input.repo).store.createBlob(input.content);
    return { sha };
  }

  async createGitTree(input: {
    owner: string;
    repo: string;
    baseTree?: string;
    tree: GitTreeEntryInput[];
  }): Promise<GitTreeResult> {
    this.calls.push({ method: "createGitTree", args: [input.owner, input.repo] });
    const entry = this.requireRepo(input.owner, input.repo);
    const overlays = input.tree
      .filter((item) => item.path)
      .map((item) => ({
        path: item.path!,
        mode: item.mode,
        sha: item.sha,
      }));
    const sha = input.baseTree
      ? entry.store.createTreeWithBase(overlays, input.baseTree)
      : entry.store.createTreeFromFlatEntries(overlays);
    return { sha };
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
    this.calls.push({ method: "createGitCommit", args: [input.owner, input.repo] });
    const entry = this.requireRepo(input.owner, input.repo);
    const sha = entry.store.createCommitRecord({
      message: input.message,
      treeSha: input.tree,
      parents: input.parents,
      author: input.author,
      committer: input.committer,
    });
    return {
      sha,
      tree: { sha: input.tree },
      parents: input.parents.map((parent) => ({ sha: parent })),
    };
  }

  async getGitCommit(
    owner: string,
    repo: string,
    sha: string,
  ): Promise<GitCommitResult> {
    this.calls.push({ method: "getGitCommit", args: [owner, repo, sha] });
    const commit = this.requireRepo(owner, repo).store.getCommit(sha);
    if (!commit) {
      throw new Error(`Mock commit ${sha} not found.`);
    }
    return {
      sha,
      tree: { sha: commit.treeSha },
      parents: commit.parents.map((parent) => ({ sha: parent })),
    };
  }

  async getGitRef(owner: string, repo: string, ref: string): Promise<GitRefResult> {
    this.calls.push({ method: "getGitRef", args: [owner, repo, ref] });
    const branch = normalizeRef(ref);
    const head = this.resolveBranchHead(this.requireRepo(owner, repo), branch);
    return { ref: `refs/heads/${branch}`, object: { sha: head } };
  }

  async updateGitRef(input: {
    owner: string;
    repo: string;
    ref: string;
    sha: string;
    force?: boolean;
    expectedSha?: string;
  }): Promise<GitRefResult> {
    this.calls.push({ method: "updateGitRef", args: [input] });
    if (input.force) {
      throw new Error("Force ref updates are not allowed in mock runner upgrade.");
    }
    const entry = this.requireRepo(input.owner, input.repo);
    const branch = normalizeRef(input.ref);
    const current = entry.branchHeads.get(branch);
    if (input.expectedSha && current && current !== input.expectedSha) {
      throw new Error(
        `Ref update rejected: expected ${input.expectedSha}, found ${current}.`,
      );
    }
    entry.branchHeads.set(branch, input.sha);
    if (branch === entry.metadata.defaultBranch) {
      entry.store.updateRef(input.sha, input.expectedSha);
    }
    return { ref: `refs/heads/${branch}`, object: { sha: input.sha } };
  }

  async createGitRef(input: {
    owner: string;
    repo: string;
    ref: string;
    sha: string;
  }): Promise<GitRefResult> {
    this.calls.push({ method: "createGitRef", args: [input] });
    const entry = this.requireRepo(input.owner, input.repo);
    const branch = normalizeRef(input.ref);
    entry.branchHeads.set(branch, input.sha);
    return { ref: `refs/heads/${branch}`, object: { sha: input.sha } };
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
    this.calls.push({ method: "listPullRequests", args: [owner, repo, opts] });
    const entry = this.requireRepo(owner, repo);
    return entry.pullRequests.filter((pr) => {
      if (opts.state && opts.state !== "all" && pr.state !== opts.state) {
        return false;
      }
      if (opts.base && pr.baseRef !== opts.base) {
        return false;
      }
      if (opts.head) {
        const expectedHead = opts.head.includes(":")
          ? opts.head.split(":")[1]
          : opts.head;
        if (pr.headRef !== expectedHead) {
          return false;
        }
      }
      return true;
    });
  }

  async createPullRequest(input: {
    owner: string;
    repo: string;
    title: string;
    head: string;
    base: string;
    body: string;
  }): Promise<{ number: number; htmlUrl: string }> {
    this.calls.push({ method: "createPullRequest", args: [input] });
    const entry = this.requireRepo(input.owner, input.repo);
    const headSha = this.resolveBranchHead(entry, input.head);
    const number = entry.nextPrNumber++;
    const htmlUrl = `https://github.com/${input.owner}/${input.repo}/pull/${number}`;
    entry.pullRequests.push({
      number,
      htmlUrl,
      headRef: input.head,
      baseRef: input.base,
      body: input.body,
      state: "open",
      headSha,
    });
    return { number, htmlUrl };
  }

  async updatePullRequest(
    owner: string,
    repo: string,
    number: number,
    patch: { body?: string; title?: string },
  ): Promise<void> {
    this.calls.push({ method: "updatePullRequest", args: [owner, repo, number, patch] });
    const entry = this.requireRepo(owner, repo);
    const pr = entry.pullRequests.find((candidate) => candidate.number === number);
    if (!pr) {
      throw new Error(`Mock PR #${number} not found.`);
    }
    if (patch.body !== undefined) {
      pr.body = patch.body;
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
    this.calls.push({
      method: "mergePullRequest",
      args: [owner, repo, number, options],
    });
    const entry = this.requireRepo(owner, repo);
    const pr = entry.pullRequests.find((candidate) => candidate.number === number);
    if (!pr) {
      throw new Error(`Mock PR #${number} not found.`);
    }
    if (options.expectedHeadSha) {
      pr.headSha = options.expectedHeadSha;
    }
    pr.state = "closed";
    entry.branchHeads.set(entry.metadata.defaultBranch, pr.headSha);
    entry.store.updateRef(pr.headSha);
    for (const [path] of entry.remoteFiles.entries()) {
      const atHead = entry.store.readFileAtCommit(pr.headSha, path);
      if (atHead) {
        entry.remoteFiles.set(path, atHead.toString("utf8"));
      }
    }
  }

  async dispatchWorkflow(
    owner: string,
    repo: string,
    workflowIdOrPath: string,
    ref: string,
    inputs?: Record<string, string>,
  ): Promise<{ runId?: number }> {
    this.calls.push({
      method: "dispatchWorkflow",
      args: [owner, repo, workflowIdOrPath, ref, inputs],
    });
    const entry = this.requireRepo(owner, repo);
    const runId = entry.nextWorkflowRunId++;
    const operationId = inputs?.canary_operation_id?.trim();
    const runName = operationId
      ? `PDev runner config canary ${operationId}`
      : "PDev runner config canary";
    const run: RunnerUpgradeWorkflowRun = {
      id: runId,
      status: "completed",
      conclusion: this.canaryConclusion,
      htmlUrl: `https://github.com/${owner}/${repo}/actions/runs/${runId}`,
      createdAt: new Date().toISOString(),
      name: runName,
      displayTitle: runName,
    };
    entry.workflowRuns.push(run);
    // Simulate GitHub workflow_dispatch 204: no run id in the response body.
    return {};
  }

  async getWorkflowRun(
    owner: string,
    repo: string,
    runId: number,
  ): Promise<RunnerUpgradeWorkflowRun> {
    this.calls.push({ method: "getWorkflowRun", args: [owner, repo, runId] });
    const entry = this.requireRepo(owner, repo);
    const run = entry.workflowRuns.find((candidate) => candidate.id === runId);
    if (!run) {
      throw new Error(`Mock workflow run ${runId} not found.`);
    }
    return run;
  }

  async listWorkflowRuns(
    owner: string,
    repo: string,
    workflowIdOrPath: string,
    _opts?: { branch?: string; event?: string },
  ): Promise<RunnerUpgradeWorkflowRun[]> {
    this.calls.push({
      method: "listWorkflowRuns",
      args: [owner, repo, workflowIdOrPath],
    });
    return this.requireRepo(owner, repo).workflowRuns;
  }

  async writeHarnessSecrets(
    repo: string,
    secrets: HarnessSecretWriteRequest[],
  ): Promise<HarnessSecretWriteResultEntry[]> {
    this.calls.push({
      method: "writeHarnessSecrets",
      args: [repo, secrets.map((entry) => entry.name)],
    });
    if (this.syncShouldFail) {
      throw new Error("Mock harness secret write failed.");
    }
    this.remoteWriteOrder.push("secret");
    return secrets.map((secret) => ({ name: secret.name, status: "updated" }));
  }

  async writeHarnessVariables(
    repo: string,
    variables: HarnessVariableWriteRequest[],
  ): Promise<HarnessVariableWriteResultEntry[]> {
    this.calls.push({
      method: "writeHarnessVariables",
      args: [repo, variables.map((entry) => entry.name)],
    });
    if (this.syncShouldFail) {
      throw new Error("Mock harness variable write failed.");
    }
    this.remoteWriteOrder.push("variable");
    return variables.map((variable) => ({ name: variable.name, status: "updated" }));
  }

  updateRemoteFile(
    slug: string,
    path: string,
    content: string,
    branch?: string,
  ): void {
    const entry = this.repositories.get(slug);
    if (!entry) {
      throw new Error(`Mock repository ${slug} is not configured.`);
    }
    entry.remoteFiles.set(path, content);
    const targetBranch = branch ?? entry.metadata.defaultBranch;
    const headSha = entry.branchHeads.get(targetBranch);
    if (!headSha) {
      return;
    }
    const blobSha = entry.store.createBlob(Buffer.from(content, "utf8"));
    const commit = entry.store.getCommit(headSha);
    const parent = commit?.parents[0];
    const parentTree = parent ? entry.store.getCommit(parent)?.treeSha : undefined;
    const treeSha = entry.store.createTreeWithBase(
      [{ path, mode: "100644", sha: blobSha }],
      parentTree ?? commit?.treeSha ?? "",
    );
    const newCommit = entry.store.createCommitRecord({
      message: `Update ${path}`,
      treeSha,
      parents: [headSha],
    });
    entry.branchHeads.set(targetBranch, newCommit);
    if (targetBranch === entry.metadata.defaultBranch) {
      entry.store.updateRef(newCommit, headSha);
    }
  }
}

export async function createMockRunnerUpgradeProvider(
  state: MockRunnerUpgradeProviderState = {},
): Promise<MockRunnerUpgradeProvider> {
  return MockRunnerUpgradeProvider.create(state);
}

export function asRemoteSetupProviderForRunnerUpgrade(
  provider: RunnerUpgradeGitHubProvider,
): import("./github-remote-provider.js").GitHubRemoteSetupProvider {
  return {
    checkHarnessRepoAccess: async () => "available",
    listHarnessSecretStatuses: async () => [],
    checkTargetWorkflowStatus: async () => ({
      repoAccess: "available",
      workflowStatus: "unknown",
    }),
    writeHarnessSecrets: async (harnessDispatchRepo, secrets) => {
      if (!provider.writeHarnessSecrets) {
        throw new Error("Provider does not support writeHarnessSecrets.");
      }
      return provider.writeHarnessSecrets(harnessDispatchRepo, secrets);
    },
    writeHarnessVariables: async (harnessDispatchRepo, variables) => {
      if (!provider.writeHarnessVariables) {
        throw new Error("Provider does not support writeHarnessVariables.");
      }
      return provider.writeHarnessVariables(harnessDispatchRepo, variables);
    },
    applyTargetWorkflowPr: async () => {
      throw new Error("Target workflow apply is not supported in runner upgrade.");
    },
  };
}
