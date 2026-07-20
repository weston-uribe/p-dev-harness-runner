import { redactSecretsString } from "../artifacts/redact.js";
import {
  GitHubApiError,
  GitHubClient,
  type GitHubClientOptions,
} from "../github/client.js";
import { encryptGitHubActionsSecret } from "./github-secret-encryption.js";
import {
  compareTargetWorkflowContent,
  hashWorkflowContent,
} from "./target-workflow-setup.js";
import {
  HARNESS_ACTIONS_SECRET_NAMES,
  type HarnessSecretStatusEntry,
  type RemoteAccessStatus,
  type RemoteWorkflowStatus,
} from "./remote-actions.js";
import {
  mapGitHubAccessErrorToStatus,
  mapGitHubSecretMetadataToStatus,
  type GitHubHarnessProvisioningProvider,
  type GitHubRemoteSetupProvider,
  type AuthenticatedGitHubUser,
  type CreateRepositoryFromTemplateInput,
  type CreateRepositoryFromTemplateResult,
  type CreateUserRepositoryInput,
  type CreateUserRepositoryResult,
  type GitBlobResult,
  type GitCommitResult,
  type GitRefResult,
  type GitTreeEntryInput,
  type GitTreeResult,
  type GitHubRepositoryMetadata,
  type GitHubTokenCapabilitySummary,
  type HarnessSecretWriteRequest,
  type HarnessSecretWriteResultEntry,
  type HarnessVariableWriteRequest,
  type HarnessVariableWriteResultEntry,
  type RepositoryFileWriteInput,
  type TargetWorkflowApplyInput,
  type TargetWorkflowApplyResult,
} from "./github-remote-provider.js";
import {
  classicPatHasRepoScope,
  classicPatHasWorkflowScope,
  resolveGitHubTokenType,
} from "./github-workflow-permissions.js";
import {
  buildGitHubHttpsRemoteUrl,
  pushHarnessSnapshotViaGit,
} from "./harness-snapshot-git-transport.js";
import type { WorkspaceSnapshotManifest } from "../p-dev/workspace-snapshot-types.js";

export function parseRepoSlug(slug: string): { owner: string; repo: string } {
  const [owner, repo] = slug.split("/");
  if (!owner || !repo) {
    throw new Error(`Invalid GitHub repo slug: ${slug}`);
  }
  return { owner, repo };
}

interface GitHubApiErrorBody {
  message?: string;
  documentation_url?: string;
}

import {
  GITHUB_STEP5_WORKFLOW_PERMISSION_FALLBACK_PREFIX,
  GITHUB_WORKFLOW_SCOPE_SETUP_ERROR,
} from "./github-workflow-permissions.js";

function tryParseGitHubApiErrorBody(raw: string): GitHubApiErrorBody | null {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{")) {
    return null;
  }

  try {
    const parsed = JSON.parse(trimmed) as GitHubApiErrorBody;
    return typeof parsed.message === "string" ? parsed : null;
  } catch {
    return null;
  }
}

function isWorkflowScopeError(status: number, apiMessage: string): boolean {
  return (
    status === 403 &&
    /workflow/i.test(apiMessage) &&
    (/scope/i.test(apiMessage) || /OAuth App/i.test(apiMessage))
  );
}

function isLikelyWorkflowScopeNotFound(
  status: number,
  apiMessage: string,
  body: GitHubApiErrorBody | null,
): boolean {
  return (
    status === 404 &&
    apiMessage === "Not Found" &&
    body?.documentation_url?.includes("create-or-update-file-contents") === true
  );
}

export function formatGitHubApiErrorMessage(
  status: number,
  rawBody: string,
  options?: { workflowFileOperation?: boolean },
): string {
  const redacted = redactSecretsString(rawBody);
  const parsed = tryParseGitHubApiErrorBody(redacted);
  const apiMessage = parsed?.message ?? redacted;

  if (isWorkflowScopeError(status, apiMessage)) {
    return GITHUB_WORKFLOW_SCOPE_SETUP_ERROR;
  }

  if (
    options?.workflowFileOperation &&
    isLikelyWorkflowScopeNotFound(status, apiMessage, parsed)
  ) {
    return `${GITHUB_WORKFLOW_SCOPE_SETUP_ERROR} (GitHub returned HTTP ${status}: Not Found.)`;
  }

  if (parsed?.message) {
    return `GitHub API ${status}: ${parsed.message}`;
  }

  if (redacted && !redacted.startsWith("{")) {
    return `GitHub API ${status}: ${redacted}`;
  }

  return `GitHub API ${status}: request failed`;
}

export function sanitizeGitHubSetupError(error: unknown): string {
  if (error instanceof GitHubApiError) {
    return formatGitHubApiErrorMessage(error.status, error.message);
  }
  if (error instanceof Error) {
    return redactSecretsString(error.message);
  }
  return redactSecretsString(String(error));
}

export function preserveGitHubSetupError(error: unknown): Error {
  if (error instanceof GitHubApiError) {
    return new GitHubApiError(
      error.status,
      formatGitHubApiErrorMessage(error.status, error.message),
      {
        retryAfterSeconds: error.retryAfterSeconds,
        rateLimitRemaining: error.rateLimitRemaining,
        rateLimitResetEpochSeconds: error.rateLimitResetEpochSeconds,
        requestId: error.requestId,
      },
    );
  }
  // Preserve typed provisioning errors (timeouts, FF conflicts, tree mismatch).
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    "recoverable" in error &&
    error instanceof Error
  ) {
    return error;
  }
  return new Error(sanitizeGitHubSetupError(error));
}

export function sanitizeGitHubWorkflowSetupError(error: unknown): string {
  if (error instanceof GitHubApiError) {
    const message = formatGitHubApiErrorMessage(error.status, error.message, {
      workflowFileOperation: true,
    });
    if (
      message === GITHUB_WORKFLOW_SCOPE_SETUP_ERROR ||
      message.startsWith(`${GITHUB_WORKFLOW_SCOPE_SETUP_ERROR} `)
    ) {
      return `${GITHUB_STEP5_WORKFLOW_PERMISSION_FALLBACK_PREFIX}${message}`;
    }
    return message;
  }
  return sanitizeGitHubSetupError(error);
}

export class LiveGitHubRemoteSetupProvider implements GitHubRemoteSetupProvider {
  private readonly client: GitHubClient;

  constructor(options: GitHubClientOptions | GitHubClient) {
    this.client =
      options instanceof GitHubClient
        ? options
        : new GitHubClient(options);
  }

  async checkHarnessRepoAccess(
    harnessDispatchRepo: string,
  ): Promise<RemoteAccessStatus> {
    try {
      const { owner, repo } = parseRepoSlug(harnessDispatchRepo);
      const repository = await this.client.getRepository(owner, repo);
      if (
        repository.permissions?.admin === true ||
        repository.permissions?.maintain === true
      ) {
        return "available";
      }
      return "denied";
    } catch (error) {
      if (error instanceof GitHubApiError) {
        return mapGitHubAccessErrorToStatus(error.status);
      }
      return "unknown";
    }
  }

  async listHarnessSecretStatuses(
    harnessDispatchRepo: string,
  ): Promise<HarnessSecretStatusEntry[]> {
    try {
      const { owner, repo } = parseRepoSlug(harnessDispatchRepo);
      const response = await this.client.listActionsSecrets(owner, repo);
      return mapGitHubSecretMetadataToStatus(
        response.secrets.map((secret) => secret.name),
        HARNESS_ACTIONS_SECRET_NAMES,
      );
    } catch (error) {
      if (error instanceof GitHubApiError) {
        if (error.status === 401 || error.status === 403 || error.status === 404) {
          return HARNESS_ACTIONS_SECRET_NAMES.map((name: (typeof HARNESS_ACTIONS_SECRET_NAMES)[number]) => ({
            name,
            status: "unknown" as const,
          }));
        }
      }
      throw new Error(sanitizeGitHubSetupError(error));
    }
  }

  async writeHarnessSecrets(
    harnessDispatchRepo: string,
    secrets: HarnessSecretWriteRequest[],
  ): Promise<HarnessSecretWriteResultEntry[]> {
    const { owner, repo } = parseRepoSlug(harnessDispatchRepo);
    const publicKey = await this.client.getActionsPublicKey(owner, repo);
    const existing = await this.listHarnessSecretStatuses(harnessDispatchRepo);
    const existingNames = new Set(
      existing
        .filter((entry) => entry.status === "present")
        .map((entry) => entry.name),
    );

    const results: HarnessSecretWriteResultEntry[] = [];
    for (const secret of secrets) {
      const encryptedValue = encryptGitHubActionsSecret(
        secret.value,
        publicKey.key,
      );
      await this.client.upsertActionsSecret(
        owner,
        repo,
        secret.name,
        encryptedValue,
        publicKey.key_id,
      );
      results.push({
        name: secret.name,
        status: existingNames.has(secret.name) ? "updated" : "created",
      });
    }
    return results;
  }

  async writeHarnessVariables(
    harnessDispatchRepo: string,
    variables: HarnessVariableWriteRequest[],
  ): Promise<HarnessVariableWriteResultEntry[]> {
    const { owner, repo } = parseRepoSlug(harnessDispatchRepo);
    const results: HarnessVariableWriteResultEntry[] = [];
    for (const variable of variables) {
      const status = await this.client.upsertActionsVariable(
        owner,
        repo,
        variable.name,
        variable.value,
      );
      results.push({ name: variable.name, status });
    }
    return results;
  }

  async readHarnessVariable(
    harnessDispatchRepo: string,
    name: string,
  ): Promise<{ name: string; value: string } | null> {
    const { owner, repo } = parseRepoSlug(harnessDispatchRepo);
    return this.client.getActionsVariable(owner, repo, name);
  }

  async checkTargetWorkflowStatus(input: {
    targetRepoSlug: string;
    workflowPath: string;
    intendedWorkflowContent: string;
    productionBranch: string;
  }): Promise<{
    repoAccess: RemoteAccessStatus;
    workflowStatus: RemoteWorkflowStatus;
    productionBranchSha?: string;
  }> {
    try {
      const { owner, repo } = parseRepoSlug(input.targetRepoSlug);
      const repository = await this.client.getRepository(owner, repo);
      const repoAccess =
        repository.permissions?.push === true ||
        repository.permissions?.admin === true
          ? "available"
          : "denied";

      const productionRef = await this.client.getBranchRef(
        owner,
        repo,
        input.productionBranch,
      );
      const productionBranchSha = productionRef.object.sha;
      const content = await this.client.getRepositoryContent(
        owner,
        repo,
        input.workflowPath,
        input.productionBranch,
      );
      const existingContent = content
        ? this.client.decodeRepositoryContent(content)
        : null;
      const workflowStatus = compareTargetWorkflowContent(
        existingContent,
        input.intendedWorkflowContent,
      );

      return {
        repoAccess,
        workflowStatus,
        productionBranchSha,
      };
    } catch (error) {
      if (error instanceof GitHubApiError) {
        if (error.status === 404) {
          return {
            repoAccess: "denied",
            workflowStatus: "unknown",
          };
        }
        return {
          repoAccess: mapGitHubAccessErrorToStatus(error.status),
          workflowStatus: "unknown",
        };
      }
      throw new Error(sanitizeGitHubSetupError(error));
    }
  }

  async applyTargetWorkflowPr(
    input: TargetWorkflowApplyInput,
  ): Promise<TargetWorkflowApplyResult> {
    if (input.branchName === input.productionBranch) {
      throw new Error("Direct production branch writes are not allowed");
    }

    const { owner, repo } = parseRepoSlug(input.targetRepoSlug);
    const productionContent = await this.client.getRepositoryContent(
      owner,
      repo,
      input.workflowPath,
      input.productionBranch,
    );
    if (productionContent) {
      const existingOnProduction = this.client.decodeRepositoryContent(
        productionContent,
      );
      if (
        hashWorkflowContent(existingOnProduction) ===
        hashWorkflowContent(input.workflowContent)
      ) {
        return {
          outcome: "already-installed",
          branchName: input.branchName,
          directProductionBranchWrite: false,
        };
      }
    }

    const productionRef = await this.client.getBranchRef(
      owner,
      repo,
      input.productionBranch,
    );
    const productionSha = productionRef.object.sha;

    let installBranchExists = true;
    try {
      await this.client.getBranchRef(owner, repo, input.branchName);
    } catch (error) {
      if (error instanceof GitHubApiError && error.status === 404) {
        installBranchExists = false;
      } else {
        throw error;
      }
    }

    if (!installBranchExists) {
      await this.client.createGitRef(
        owner,
        repo,
        input.branchName,
        productionSha,
      );
    }

    const existingOnBranch = await this.client.getRepositoryContent(
      owner,
      repo,
      input.workflowPath,
      input.branchName,
    );
    const existingSha = existingOnBranch?.sha;
    const existingContent = existingOnBranch
      ? this.client.decodeRepositoryContent(existingOnBranch)
      : null;

    if (
      existingContent &&
      hashWorkflowContent(existingContent) ===
        hashWorkflowContent(input.workflowContent)
    ) {
      return this.resolveInstallPullRequestOutcome(input);
    }

    await this.client.createOrUpdateRepositoryFile({
      owner,
      repo,
      path: input.workflowPath,
      branch: input.branchName,
      message: input.prTitle,
      content: input.workflowContent,
      sha: existingSha,
    });

    return this.resolveInstallPullRequestOutcome(input);
  }

  private async resolveInstallPullRequestOutcome(
    input: TargetWorkflowApplyInput,
  ): Promise<TargetWorkflowApplyResult> {
    const openPr = await this.findOpenInstallPullRequest(input);
    if (openPr) {
      return {
        outcome: "pr-updated",
        branchName: input.branchName,
        prUrl: openPr.html_url,
        directProductionBranchWrite: false,
      };
    }

    const { owner, repo } = parseRepoSlug(input.targetRepoSlug);
    const created = await this.client.createPullRequest({
      owner,
      repo,
      title: input.prTitle,
      head: input.branchName,
      base: input.productionBranch,
      body: input.prBody,
    });

    return {
      outcome: "pr-created",
      branchName: input.branchName,
      prUrl: created.html_url,
      directProductionBranchWrite: false,
    };
  }

  private async findOpenInstallPullRequest(input: TargetWorkflowApplyInput) {
    const { owner, repo } = parseRepoSlug(input.targetRepoSlug);
    const pulls = await this.client.listPullRequests(owner, repo, {
      state: "open",
      base: input.productionBranch,
      head: `${owner}:${input.branchName}`,
    });
    return pulls[0];
  }
}

export function createLiveGitHubRemoteSetupProvider(
  token: string,
): GitHubRemoteSetupProvider {
  return new LiveGitHubRemoteSetupProvider({ token });
}

export class LiveGitHubHarnessProvisioningProvider
  implements GitHubHarnessProvisioningProvider
{
  private readonly client: GitHubClient;
  private readonly token: string;

  constructor(options: GitHubClientOptions | GitHubClient) {
    if (options instanceof GitHubClient) {
      this.client = options;
      // Token is private on GitHubClient; live push requires explicit token options.
      this.token = "";
    } else {
      this.client = new GitHubClient(options);
      this.token = options.token;
    }
  }

  private mapRepositoryToMetadata(
    owner: string,
    repo: string,
    repository: Awaited<ReturnType<GitHubClient["getRepository"]>>,
  ): GitHubRepositoryMetadata {
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
      repositoryId: repository.id,
      owner,
      repo,
      description: repository.description ?? null,
      private: repository.private === true,
      visibility:
        repository.visibility ?? (repository.private ? "private" : "public"),
      isTemplate: repository.is_template === true,
      defaultBranch: repository.default_branch ?? "main",
      permissions: {
        admin: repository.permissions?.admin === true,
        maintain: repository.permissions?.maintain === true,
        push: repository.permissions?.push === true,
      },
    };
  }

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
    const scopeAmbiguous =
      tokenType === "classic" && inspected.oauthScopes.length === 0;
    return {
      login: inspected.login,
      tokenType,
      hasRepoScope: classicPatHasRepoScope(inspected.oauthScopes),
      hasWorkflowScope: classicPatHasWorkflowScope(inspected.oauthScopes),
      scopeAmbiguous,
    };
  }

  async getRepositoryMetadata(
    owner: string,
    repo: string,
  ): Promise<GitHubRepositoryMetadata | null> {
    try {
      const repository = await this.client.getRepository(owner, repo);
      return this.mapRepositoryToMetadata(owner, repo, repository);
    } catch (error) {
      if (error instanceof GitHubApiError && error.status === 404) {
        return null;
      }
      throw preserveGitHubSetupError(error);
    }
  }

  async getRepositoryMetadataById(
    repositoryId: number,
  ): Promise<GitHubRepositoryMetadata | null> {
    try {
      const repository = await this.client.getRepositoryById(repositoryId);
      const fullName = repository.full_name;
      if (!fullName || !fullName.includes("/")) {
        throw new Error(
          `GitHub repository ID ${repositoryId} returned invalid full_name metadata.`,
        );
      }
      const [owner, repo] = fullName.split("/");
      if (!owner || !repo) {
        throw new Error(
          `GitHub repository ID ${repositoryId} returned invalid full_name metadata.`,
        );
      }
      return this.mapRepositoryToMetadata(owner, repo, repository);
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
  ): Promise<string> {
    const ref = await this.client.getBranchRef(owner, repo, branch);
    return ref.object.sha;
  }

  async readRepositoryFileContent(
    owner: string,
    repo: string,
    filePath: string,
    ref: string,
  ): Promise<string | null> {
    const content = await this.client.getRepositoryContent(
      owner,
      repo,
      filePath,
      ref,
    );
    return content ? this.client.decodeRepositoryContent(content) : null;
  }

  async createRepositoryFromTemplate(
    input: CreateRepositoryFromTemplateInput,
  ): Promise<CreateRepositoryFromTemplateResult> {
    try {
      const created = await this.client.createRepositoryFromTemplate({
        templateOwner: input.templateOwner,
        templateRepo: input.templateRepo,
        owner: input.owner,
        name: input.name,
        description: input.description,
        private: input.private,
        includeAllBranches: input.includeAllBranches,
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

  async createUserRepository(
    input: CreateUserRepositoryInput,
  ): Promise<CreateUserRepositoryResult> {
    try {
      const created = await this.client.createUserRepository({
        name: input.name,
        description: input.description,
        private: input.private,
        autoInit: input.autoInit,
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
    author?: { name: string; email: string; date: string };
    committer?: { name: string; email: string; date: string };
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
        const current = await this.client.getGitRef(input.owner, input.repo, input.ref);
        if (current.object.sha === input.sha) {
          return {
            ref: current.ref,
            object: { sha: input.sha },
          };
        }
        if (current.object.sha !== input.expectedSha) {
          throw new Error(
            `Ref update rejected: expected parent HEAD ${input.expectedSha}, found ${current.object.sha}.`,
          );
        }
      }
      const gitRef = await this.client.updateGitRef(input);
      return {
        ref: gitRef.ref,
        object: { sha: gitRef.object.sha },
      };
    } catch (error) {
      throw preserveGitHubSetupError(error);
    }
  }

  async updateUserRepositoryDescription(input: {
    owner: string;
    repo: string;
    description: string;
  }): Promise<void> {
    try {
      await this.client.updateUserRepository(input);
    } catch (error) {
      throw preserveGitHubSetupError(error);
    }
  }

  async writeRepositoryFile(
    input: RepositoryFileWriteInput,
  ): Promise<{ commitSha: string }> {
    try {
      return await this.client.createOrUpdateRepositoryFile({
        owner: input.owner,
        repo: input.repo,
        path: input.path,
        branch: input.branch,
        message: input.message,
        content: input.content,
        sha: input.sha,
      });
    } catch (error) {
      throw preserveGitHubSetupError(error);
    }
  }

  async pushHarnessSnapshotCommits(input: {
    owner: string;
    repo: string;
    defaultBranch: string;
    expectedHeadSha: string;
    initializedCommitSha: string;
    snapshotRoot: string;
    manifest: WorkspaceSnapshotManifest;
    operationId: string;
    packageVersion: string;
    buildMarkerContent: (snapshotCommitSha: string) => string;
    existingSnapshotCommitSha?: string;
    timeoutMs?: number;
    onProgress?: (progress: {
      phase: "preparing-snapshot" | "workspace-uploading" | "verifying";
      completed?: number;
      total?: number;
    }) => void;
  }): Promise<{
    snapshotCommitSha: string;
    markerCommitSha: string;
    snapshotGitTreeSha1: string;
    pushCount: number;
    timings: import("./harness-snapshot-git-transport.js").HarnessGitTransportTimings;
  }> {
    if (!this.token) {
      throw new Error(
        "Live GitHub provisioning provider is missing a token for authenticated git push.",
      );
    }
    try {
      const result = await pushHarnessSnapshotViaGit({
        auth: {
          remoteUrl: buildGitHubHttpsRemoteUrl(input.owner, input.repo),
          token: this.token,
        },
        owner: input.owner,
        repo: input.repo,
        defaultBranch: input.defaultBranch,
        expectedHeadSha: input.expectedHeadSha,
        initializedCommitSha: input.initializedCommitSha,
        snapshotRoot: input.snapshotRoot,
        manifest: input.manifest,
        operationId: input.operationId,
        buildMarkerContent: input.buildMarkerContent,
        existingSnapshotCommitSha: input.existingSnapshotCommitSha,
        timeoutMs: input.timeoutMs,
        onProgress: input.onProgress,
      });
      return {
        snapshotCommitSha: result.snapshotCommitSha,
        markerCommitSha: result.markerCommitSha,
        snapshotGitTreeSha1: result.snapshotGitTreeSha1,
        pushCount: result.pushCount,
        timings: result.timings,
      };
    } catch (error) {
      throw preserveGitHubSetupError(error);
    }
  }
}

export function createLiveGitHubHarnessProvisioningProvider(
  token: string,
): GitHubHarnessProvisioningProvider {
  return new LiveGitHubHarnessProvisioningProvider({ token });
}
