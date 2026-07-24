import { redactSecretsString } from "../artifacts/redact.js";
import {
  extractGitHubRateLimitMetadata,
  type GitHubRateLimitMetadata,
} from "./rate-limit-metadata.js";

export type { GitHubRateLimitMetadata };

export class GitHubApiError extends Error {
  readonly status: number;
  readonly retryAfterSeconds?: number;
  readonly rateLimitRemaining?: number;
  readonly rateLimitResetEpochSeconds?: number;
  readonly requestId?: string;

  constructor(
    status: number,
    message: string,
    metadata?: GitHubRateLimitMetadata,
  ) {
    super(message);
    this.name = "GitHubApiError";
    this.status = status;
    if (metadata) {
      this.retryAfterSeconds = metadata.retryAfterSeconds;
      this.rateLimitRemaining = metadata.rateLimitRemaining;
      this.rateLimitResetEpochSeconds = metadata.rateLimitResetEpochSeconds;
      this.requestId = metadata.requestId;
    }
  }
}

function createGitHubApiError(
  status: number,
  rawBody: string,
  headers?: Headers,
): GitHubApiError {
  const message = redactSecretsString(
    rawBody || `GitHub API request failed: ${status}`,
  );
  const metadata = headers ? extractGitHubRateLimitMetadata(headers) : undefined;
  return new GitHubApiError(status, message, metadata);
}

export interface GitHubClientOptions {
  token: string;
  /** Optional per-request timeout for REST/GraphQL fetch calls. */
  timeoutMs?: number;
}

export interface GitHubPullRequest {
  node_id: string;
  title: string;
  html_url: string;
  state: string;
  merged: boolean;
  draft?: boolean;
  merged_at: string | null;
  merge_commit_sha: string | null;
  mergeable?: boolean | null;
  mergeable_state?: string | null;
  rebaseable?: boolean | null;
  head: { ref: string; sha: string };
  base: { ref: string; sha: string };
}

export interface GitHubRepository {
  id?: number;
  name?: string;
  full_name?: string;
  description?: string | null;
  private?: boolean;
  visibility?: string;
  is_template?: boolean;
  default_branch?: string;
  permissions?: {
    admin?: boolean;
    maintain?: boolean;
    push?: boolean;
    triage?: boolean;
    pull?: boolean;
  };
}

export interface GitHubAuthenticatedUser {
  id: number;
  login: string;
}

export interface GitHubCreateUserRepositoryInput {
  name: string;
  description: string;
  private: boolean;
  autoInit: boolean;
}

export interface GitHubCreateUserRepositoryResult {
  id: number;
  full_name: string;
  default_branch: string;
}

export interface GitHubGitBlob {
  sha: string;
}

export interface GitHubGitTreeEntry {
  path?: string;
  mode: string;
  type: "blob" | "tree";
  sha: string;
}

export interface GitHubGitTree {
  sha: string;
  tree: GitHubGitTreeEntry[];
  truncated?: boolean;
}

export interface GitHubGitCommitAuthor {
  name: string;
  email: string;
  date: string;
}

export interface GitHubGitCommit {
  sha: string;
  tree: { sha: string };
  parents: Array<{ sha: string }>;
}

export interface GitHubCreateRepositoryFromTemplateInput {
  templateOwner: string;
  templateRepo: string;
  owner: string;
  name: string;
  description: string;
  private: boolean;
  includeAllBranches?: boolean;
}

export interface GitHubCreateRepositoryFromTemplateResult {
  id: number;
  full_name: string;
  default_branch: string;
}

interface GraphQLResponse<T> {
  data?: T;
  errors?: Array<{ message: string }>;
}

export interface GitHubPullFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
}

export interface GitHubIssueComment {
  id: number;
  user: { login: string } | null;
  body: string;
  created_at: string;
}

export interface GitHubCheckRun {
  name: string;
  status: string;
  conclusion: string | null;
  details_url: string | null;
}

export interface GitHubCommitStatus {
  state: string;
  context: string;
  target_url: string | null;
}

export interface GitHubCombinedStatus {
  state: string;
  statuses: GitHubCommitStatus[];
}

export interface GitHubPullRequestListItem {
  number: number;
  html_url: string;
  state: string;
  created_at: string;
  body?: string | null;
  merged_at?: string | null;
  head: { ref: string; sha: string };
  base: { ref: string; sha: string };
}

export interface GitHubCompareResult {
  status: "identical" | "ahead" | "behind" | "diverged";
  ahead_by: number;
  behind_by: number;
  commits: Array<{ sha: string; commit: { message: string } }>;
  files?: Array<{ filename: string; status?: string }>;
}

export interface GitHubGitRef {
  ref: string;
  object: { sha: string; type: string; url: string };
}

export interface GitHubUpdateBranchResponse {
  message: string;
  url?: string;
}

export interface GitHubActionsPublicKey {
  key_id: string;
  key: string;
}

export interface GitHubActionsSecretListItem {
  name: string;
}

export interface GitHubRepositoryContent {
  name: string;
  path: string;
  sha: string;
  content: string;
  encoding: string;
}

export interface GitHubCreatePullRequestResponse {
  number: number;
  html_url: string;
  state: string;
  head: { ref: string };
  base: { ref: string };
}

export interface GitHubWorkflowRun {
  id: number;
  status: "queued" | "in_progress" | "completed" | "waiting" | "requested" | "pending";
  conclusion: "success" | "failure" | "cancelled" | "skipped" | "timed_out" | "action_required" | "neutral" | "stale" | null;
  html_url: string;
  created_at: string;
  event?: string;
  name?: string;
  display_title?: string;
}

export interface GitHubGitBlobContent {
  sha: string;
  content: string;
  encoding: string;
}

const GITHUB_API = "https://api.github.com";

export class GitHubClient {
  private readonly token: string;
  private readonly timeoutMs?: number;

  constructor(options: GitHubClientOptions) {
    this.token = options.token;
    this.timeoutMs = options.timeoutMs;
  }

  private requestSignal(external?: AbortSignal): AbortSignal | undefined {
    const signals: AbortSignal[] = [];
    if (
      typeof this.timeoutMs === "number" &&
      Number.isFinite(this.timeoutMs) &&
      this.timeoutMs > 0
    ) {
      signals.push(AbortSignal.timeout(this.timeoutMs));
    }
    if (external) {
      signals.push(external);
    }
    if (signals.length === 0) {
      return undefined;
    }
    if (signals.length === 1) {
      return signals[0];
    }
    if (typeof AbortSignal.any === "function") {
      return AbortSignal.any(signals);
    }
    return signals[0];
  }

  private async request<T>(
    path: string,
    init?: { method?: string; body?: unknown; signal?: AbortSignal },
  ): Promise<T> {
    const response = await fetch(`${GITHUB_API}${path}`, {
      method: init?.method ?? "GET",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${this.token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
      },
      body: init?.body ? JSON.stringify(init.body) : undefined,
      signal: this.requestSignal(init?.signal),
    });

    if (!response.ok) {
      const text = await response.text();
      throw createGitHubApiError(response.status, text, response.headers);
    }

    const text = await response.text();
    if (response.status === 204 || !text.trim()) {
      return {} as T;
    }

    return JSON.parse(text) as T;
  }

  private async graphqlRequest<T>(
    query: string,
    variables?: Record<string, unknown>,
  ): Promise<T> {
    const response = await fetch(`${GITHUB_API}/graphql`, {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${this.token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query, variables }),
      signal: this.requestSignal(),
    });

    if (!response.ok) {
      const text = await response.text();
      throw createGitHubApiError(response.status, text, response.headers);
    }

    const payload = (await response.json()) as GraphQLResponse<T>;
    if (payload.errors?.length) {
      throw new GitHubApiError(
        422,
        payload.errors.map((error) => error.message).join("; "),
      );
    }
    if (!payload.data) {
      throw new GitHubApiError(422, "GitHub GraphQL response missing data");
    }

    return payload.data;
  }

  async getAuthenticatedUser(): Promise<GitHubAuthenticatedUser> {
    return this.request<GitHubAuthenticatedUser>("/user");
  }

  async inspectAuthenticatedUser(): Promise<{
    login: string;
    oauthScopes: string[];
    tokenType: string | null;
  }> {
    const response = await fetch(`${GITHUB_API}/user`, {
      method: "GET",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${this.token}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });

    const text = await response.text();
    if (!response.ok) {
      throw createGitHubApiError(response.status, text, response.headers);
    }

    const payload = JSON.parse(text) as { login: string };
    return {
      login: payload.login,
      oauthScopes: (response.headers.get("x-oauth-scopes") ?? "")
        .split(",")
        .map((scope) => scope.trim().toLowerCase())
        .filter(Boolean),
      tokenType: response.headers.get("github-authentication-token-type"),
    };
  }

  async listActionsWorkflows(
    owner: string,
    repo: string,
  ): Promise<{ total_count: number }> {
    return this.request<{ total_count: number }>(
      `/repos/${owner}/${repo}/actions/workflows?per_page=1`,
    );
  }

  async getBranchRef(
    owner: string,
    repo: string,
    branch: string,
    options?: { signal?: AbortSignal },
  ): Promise<GitHubGitRef> {
    return this.request<GitHubGitRef>(
      `/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(branch)}`,
      { signal: options?.signal },
    );
  }

  async getRepository(
    owner: string,
    repo: string,
    options?: { signal?: AbortSignal },
  ): Promise<GitHubRepository> {
    return this.request<GitHubRepository>(`/repos/${owner}/${repo}`, {
      signal: options?.signal,
    });
  }

  async getRepositoryById(repositoryId: number): Promise<GitHubRepository> {
    if (!Number.isInteger(repositoryId) || repositoryId <= 0) {
      throw new Error(`Invalid GitHub repository ID: ${String(repositoryId)}`);
    }
    return this.request<GitHubRepository>(`/repositories/${repositoryId}`);
  }

  async getPullRequest(
    owner: string,
    repo: string,
    pullNumber: number,
  ): Promise<GitHubPullRequest> {
    return this.request<GitHubPullRequest>(
      `/repos/${owner}/${repo}/pulls/${pullNumber}`,
    );
  }

  async markPullRequestReadyForReview(
    owner: string,
    repo: string,
    pullNumber: number,
  ): Promise<GitHubPullRequest> {
    const pull = await this.getPullRequest(owner, repo, pullNumber);
    await this.graphqlRequest<{
      markPullRequestReadyForReview: {
        pullRequest: { isDraft: boolean } | null;
      };
    }>(
      `mutation MarkPullRequestReadyForReview($pullRequestId: ID!) {
        markPullRequestReadyForReview(input: { pullRequestId: $pullRequestId }) {
          pullRequest { isDraft }
        }
      }`,
      { pullRequestId: pull.node_id },
    );
    return this.getPullRequest(owner, repo, pullNumber);
  }

  async getPullRequestFiles(
    owner: string,
    repo: string,
    pullNumber: number,
  ): Promise<GitHubPullFile[]> {
    return this.request<GitHubPullFile[]>(
      `/repos/${owner}/${repo}/pulls/${pullNumber}/files`,
    );
  }

  async getIssueComments(
    owner: string,
    repo: string,
    issueNumber: number,
  ): Promise<GitHubIssueComment[]> {
    return this.request<GitHubIssueComment[]>(
      `/repos/${owner}/${repo}/issues/${issueNumber}/comments`,
    );
  }

  async getCheckRunsForRef(
    owner: string,
    repo: string,
    ref: string,
  ): Promise<{ check_runs: GitHubCheckRun[] }> {
    return this.request<{ check_runs: GitHubCheckRun[] }>(
      `/repos/${owner}/${repo}/commits/${ref}/check-runs`,
    );
  }

  async getCombinedStatusForRef(
    owner: string,
    repo: string,
    ref: string,
  ): Promise<GitHubCombinedStatus> {
    return this.request<GitHubCombinedStatus>(
      `/repos/${owner}/${repo}/commits/${ref}/status`,
    );
  }

  async mergePullRequest(
    owner: string,
    repo: string,
    pullNumber: number,
    options: {
      mergeMethod: "squash" | "merge" | "rebase";
      commitTitle?: string;
      expectedHeadSha?: string;
    },
  ): Promise<{ sha: string; merged: boolean; message?: string }> {
    return this.request<{ sha: string; merged: boolean; message?: string }>(
      `/repos/${owner}/${repo}/pulls/${pullNumber}/merge`,
      {
        method: "PUT",
        body: {
          merge_method: options.mergeMethod,
          ...(options.commitTitle ? { commit_title: options.commitTitle } : {}),
          ...(options.expectedHeadSha ? { sha: options.expectedHeadSha } : {}),
        },
      },
    );
  }

  async updatePullRequestBranch(
    owner: string,
    repo: string,
    pullNumber: number,
    options: { expectedHeadSha?: string } = {},
  ): Promise<GitHubUpdateBranchResponse> {
    return this.request<GitHubUpdateBranchResponse>(
      `/repos/${owner}/${repo}/pulls/${pullNumber}/update-branch`,
      {
        method: "PUT",
        body: {
          ...(options.expectedHeadSha
            ? { expected_head_sha: options.expectedHeadSha }
            : {}),
        },
      },
    );
  }

  async compareCommits(
    owner: string,
    repo: string,
    base: string,
    head: string,
  ): Promise<GitHubCompareResult> {
    return this.request<GitHubCompareResult>(
      `/repos/${owner}/${repo}/compare/${base}...${head}`,
    );
  }

  async getActionsPublicKey(
    owner: string,
    repo: string,
  ): Promise<GitHubActionsPublicKey> {
    return this.request<GitHubActionsPublicKey>(
      `/repos/${owner}/${repo}/actions/secrets/public-key`,
    );
  }

  async listActionsSecrets(
    owner: string,
    repo: string,
  ): Promise<{ secrets: GitHubActionsSecretListItem[] }> {
    return this.request<{ secrets: GitHubActionsSecretListItem[] }>(
      `/repos/${owner}/${repo}/actions/secrets?per_page=100`,
    );
  }

  async upsertActionsSecret(
    owner: string,
    repo: string,
    secretName: string,
    encryptedValue: string,
    keyId: string,
  ): Promise<void> {
    await this.request(`/repos/${owner}/${repo}/actions/secrets/${secretName}`, {
      method: "PUT",
      body: {
        encrypted_value: encryptedValue,
        key_id: keyId,
      },
    });
  }

  async getActionsVariable(
    owner: string,
    repo: string,
    name: string,
  ): Promise<{ name: string; value: string } | null> {
    try {
      return await this.request<{ name: string; value: string }>(
        `/repos/${owner}/${repo}/actions/variables/${encodeURIComponent(name)}`,
      );
    } catch (error) {
      if (error instanceof GitHubApiError && error.status === 404) {
        return null;
      }
      throw error;
    }
  }

  async upsertActionsVariable(
    owner: string,
    repo: string,
    name: string,
    value: string,
  ): Promise<"created" | "updated"> {
    const existing = await this.getActionsVariable(owner, repo, name);
    if (existing) {
      await this.request(
        `/repos/${owner}/${repo}/actions/variables/${encodeURIComponent(name)}`,
        {
          method: "PATCH",
          body: { name, value },
        },
      );
      return "updated";
    }
    await this.request(`/repos/${owner}/${repo}/actions/variables`, {
      method: "POST",
      body: { name, value },
    });
    return "created";
  }

  async getRepositoryContent(
    owner: string,
    repo: string,
    path: string,
    ref: string,
    options?: { signal?: AbortSignal },
  ): Promise<GitHubRepositoryContent | null> {
    try {
      return await this.request<GitHubRepositoryContent>(
        `/repos/${owner}/${repo}/contents/${path}?ref=${encodeURIComponent(ref)}`,
        { signal: options?.signal },
      );
    } catch (error) {
      if (error instanceof GitHubApiError && error.status === 404) {
        return null;
      }
      throw error;
    }
  }

  decodeRepositoryContent(content: GitHubRepositoryContent): string {
    return Buffer.from(content.content, "base64").toString("utf8");
  }

  async createOrUpdateRepositoryFile(input: {
    owner: string;
    repo: string;
    path: string;
    branch: string;
    message: string;
    content: string;
    sha?: string;
  }): Promise<{ commitSha: string }> {
    const response = await this.request<{
      commit: { sha: string };
    }>(`/repos/${input.owner}/${input.repo}/contents/${input.path}`, {
      method: "PUT",
      body: {
        message: input.message,
        content: Buffer.from(input.content, "utf8").toString("base64"),
        branch: input.branch,
        ...(input.sha ? { sha: input.sha } : {}),
      },
    });
    return { commitSha: response.commit.sha };
  }

  async createGitRef(
    owner: string,
    repo: string,
    branch: string,
    sha: string,
  ): Promise<GitHubGitRef> {
    return this.request<GitHubGitRef>(`/repos/${owner}/${repo}/git/refs`, {
      method: "POST",
      body: {
        ref: `refs/heads/${branch}`,
        sha,
      },
    });
  }

  async createUserRepository(
    input: GitHubCreateUserRepositoryInput,
  ): Promise<GitHubCreateUserRepositoryResult> {
    return this.request<GitHubCreateUserRepositoryResult>("/user/repos", {
      method: "POST",
      body: {
        name: input.name,
        description: input.description,
        private: input.private,
        auto_init: input.autoInit,
      },
    });
  }

  async updateUserRepository(input: {
    owner: string;
    repo: string;
    description?: string;
    default_branch?: string;
  }): Promise<GitHubRepository> {
    return this.request<GitHubRepository>(`/repos/${input.owner}/${input.repo}`, {
      method: "PATCH",
      body: {
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.default_branch !== undefined
          ? { default_branch: input.default_branch }
          : {}),
      },
    });
  }

  async createGitBlob(input: {
    owner: string;
    repo: string;
    content: Buffer;
  }): Promise<GitHubGitBlob> {
    return this.request<GitHubGitBlob>(`/repos/${input.owner}/${input.repo}/git/blobs`, {
      method: "POST",
      body: {
        content: input.content.toString("base64"),
        encoding: "base64",
      },
    });
  }

  async createGitTree(input: {
    owner: string;
    repo: string;
    baseTree?: string;
    tree: GitHubGitTreeEntry[];
  }): Promise<GitHubGitTree> {
    return this.request<GitHubGitTree>(`/repos/${input.owner}/${input.repo}/git/trees`, {
      method: "POST",
      body: {
        ...(input.baseTree ? { base_tree: input.baseTree } : {}),
        tree: input.tree,
      },
    });
  }

  async createGitCommit(input: {
    owner: string;
    repo: string;
    message: string;
    tree: string;
    parents: string[];
    author?: GitHubGitCommitAuthor;
    committer?: GitHubGitCommitAuthor;
  }): Promise<GitHubGitCommit> {
    return this.request<GitHubGitCommit>(`/repos/${input.owner}/${input.repo}/git/commits`, {
      method: "POST",
      body: {
        message: input.message,
        tree: input.tree,
        parents: input.parents,
        ...(input.author ? { author: input.author } : {}),
        ...(input.committer ? { committer: input.committer } : {}),
      },
    });
  }

  async getGitCommit(
    owner: string,
    repo: string,
    sha: string,
  ): Promise<GitHubGitCommit> {
    return this.request<GitHubGitCommit>(
      `/repos/${owner}/${repo}/git/commits/${sha}`,
    );
  }

  async getGitTree(input: {
    owner: string;
    repo: string;
    treeSha: string;
    recursive?: boolean;
  }): Promise<GitHubGitTree> {
    const params = input.recursive ? "?recursive=1" : "";
    return this.request<GitHubGitTree>(
      `/repos/${input.owner}/${input.repo}/git/trees/${input.treeSha}${params}`,
    );
  }

  async getGitRef(
    owner: string,
    repo: string,
    ref: string,
  ): Promise<GitHubGitRef> {
    const normalized = ref.startsWith("refs/heads/")
      ? ref.slice("refs/heads/".length)
      : ref.startsWith("refs/")
        ? ref.slice("refs/".length)
        : ref;
    return this.request<GitHubGitRef>(
      `/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(normalized)}`,
    );
  }

  async updateGitRef(input: {
    owner: string;
    repo: string;
    ref: string;
    sha: string;
    force?: boolean;
  }): Promise<GitHubGitRef> {
    const branch = input.ref.startsWith("refs/heads/")
      ? input.ref.slice("refs/heads/".length)
      : input.ref.startsWith("refs/")
        ? input.ref.slice("refs/".length)
        : input.ref;
    return this.request<GitHubGitRef>(
      `/repos/${input.owner}/${input.repo}/git/refs/heads/${encodeURIComponent(branch)}`,
      {
        method: "PATCH",
        body: {
          sha: input.sha,
          force: input.force ?? false,
        },
      },
    );
  }

  async createRepositoryFromTemplate(
    input: GitHubCreateRepositoryFromTemplateInput,
  ): Promise<GitHubCreateRepositoryFromTemplateResult> {
    return this.request<GitHubCreateRepositoryFromTemplateResult>(
      `/repos/${input.templateOwner}/${input.templateRepo}/generate`,
      {
        method: "POST",
        body: {
          owner: input.owner,
          name: input.name,
          description: input.description,
          private: input.private,
          include_all_branches: input.includeAllBranches ?? false,
        },
      },
    );
  }

  async createPullRequest(input: {
    owner: string;
    repo: string;
    title: string;
    head: string;
    base: string;
    body: string;
  }): Promise<GitHubCreatePullRequestResponse> {
    return this.request<GitHubCreatePullRequestResponse>(
      `/repos/${input.owner}/${input.repo}/pulls`,
      {
        method: "POST",
        body: {
          title: input.title,
          head: input.head,
          base: input.base,
          body: input.body,
        },
      },
    );
  }

  async listPullRequests(
    owner: string,
    repo: string,
    options: {
      state?: "open" | "closed" | "all";
      base?: string;
      head?: string;
      sort?: "created" | "updated";
      direction?: "asc" | "desc";
    } = {},
  ): Promise<GitHubPullRequestListItem[]> {
    const params = new URLSearchParams();
    params.set("state", options.state ?? "open");
    if (options.base) {
      params.set("base", options.base);
    }
    if (options.head) {
      params.set("head", options.head);
    }
    params.set("sort", options.sort ?? "created");
    params.set("direction", options.direction ?? "desc");
    return this.request<GitHubPullRequestListItem[]>(
      `/repos/${owner}/${repo}/pulls?${params.toString()}`,
    );
  }

  async updatePullRequest(
    owner: string,
    repo: string,
    pullNumber: number,
    patch: { title?: string; body?: string },
  ): Promise<void> {
    await this.request(`/repos/${owner}/${repo}/pulls/${pullNumber}`, {
      method: "PATCH",
      body: patch,
    });
  }

  async createWorkflowDispatch(
    owner: string,
    repo: string,
    workflowIdOrFileName: string,
    ref: string,
    inputs?: Record<string, string>,
  ): Promise<void> {
    const workflowId = encodeURIComponent(workflowIdOrFileName);
    await this.request(
      `/repos/${owner}/${repo}/actions/workflows/${workflowId}/dispatches`,
      {
        method: "POST",
        body: {
          ref,
          ...(inputs ? { inputs } : {}),
        },
      },
    );
  }

  async getWorkflowRun(
    owner: string,
    repo: string,
    runId: number,
  ): Promise<GitHubWorkflowRun> {
    const response = await this.request<{
      id: number;
      status: GitHubWorkflowRun["status"];
      conclusion: GitHubWorkflowRun["conclusion"];
      html_url: string;
      created_at: string;
      event?: string;
      name?: string;
      display_title?: string;
    }>(`/repos/${owner}/${repo}/actions/runs/${runId}`);
    return {
      id: response.id,
      status: response.status,
      conclusion: response.conclusion,
      html_url: response.html_url,
      created_at: response.created_at,
      event: response.event,
      name: response.name,
      display_title: response.display_title,
    };
  }

  async listCommits(
    owner: string,
    repo: string,
    options: {
      sha?: string;
      path?: string;
      perPage?: number;
    } = {},
  ): Promise<Array<{ sha: string }>> {
    const params = new URLSearchParams();
    params.set("per_page", String(options.perPage ?? 1));
    if (options.sha) {
      params.set("sha", options.sha);
    }
    if (options.path) {
      params.set("path", options.path);
    }
    const response = await this.request<Array<{ sha: string }>>(
      `/repos/${owner}/${repo}/commits?${params.toString()}`,
    );
    return response ?? [];
  }

  async listWorkflowRuns(
    owner: string,
    repo: string,
    workflowIdOrFileName: string,
    options: {
      branch?: string;
      event?: string;
      perPage?: number;
    } = {},
  ): Promise<GitHubWorkflowRun[]> {
    const params = new URLSearchParams();
    params.set("per_page", String(options.perPage ?? 10));
    if (options.branch) {
      params.set("branch", options.branch);
    }
    if (options.event) {
      params.set("event", options.event);
    }
    const workflowId = encodeURIComponent(workflowIdOrFileName);
    const response = await this.request<{ workflow_runs: GitHubWorkflowRun[] }>(
      `/repos/${owner}/${repo}/actions/workflows/${workflowId}/runs?${params.toString()}`,
    );
    return response.workflow_runs ?? [];
  }

  async getGitBlob(
    owner: string,
    repo: string,
    blobSha: string,
  ): Promise<GitHubGitBlobContent> {
    return this.request<GitHubGitBlobContent>(
      `/repos/${owner}/${repo}/git/blobs/${blobSha}`,
    );
  }
}

export async function pingGitHub(token: string): Promise<string> {
  const client = new GitHubClient({ token });
  const user = await client.getAuthenticatedUser();
  return user.login;
}
