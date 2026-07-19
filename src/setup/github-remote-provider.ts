import type {
  HarnessActionsSecretName,
  HarnessSecretStatusEntry,
  RemoteAccessStatus,
  RemoteWorkflowStatus,
} from "./remote-actions.js";
import { HARNESS_ACTIONS_SECRET_NAMES } from "./remote-actions.js";
import type { GitHubTokenType } from "./github-workflow-permissions.js";
import type {
  TargetWorkflowFinalizeInput,
  TargetWorkflowFinalizationResult,
} from "./target-workflow-finalization-types.js";
import {
  advanceMockTargetWorkflowFinalization,
  type MockWorkflowFinalizationScenario,
} from "./mock-target-workflow-finalization.js";
import { previewTargetWorkflowSetup } from "./target-workflow-setup.js";
import {
  type HarnessDispatchRepoResolution,
} from "./harness-dispatch-repo.js";
import {
  type MockGitRepositoryStore,
  createMockGitRepositoryStore,
} from "./mock-git-repository-store.js";
import type { GitHubGitCommitAuthor } from "../github/client.js";
import { GitHubApiError } from "../github/client.js";
import type { WorkspaceSnapshotManifest } from "../p-dev/workspace-snapshot-types.js";
import type { HarnessGitTransportTimings } from "./harness-snapshot-git-transport.js";

export interface GitCommitIdentity {
  name: string;
  email: string;
  date: string;
}

export { type GitHubGitCommitAuthor as GitCommitAuthor };

export interface GitHubRepositoryMetadata {
  repositoryId: number;
  owner: string;
  repo: string;
  description?: string | null;
  private: boolean;
  visibility: string;
  isTemplate: boolean;
  defaultBranch: string;
  permissions: {
    admin: boolean;
    maintain: boolean;
    push: boolean;
  };
}

export interface AuthenticatedGitHubUser {
  id: number;
  login: string;
}

export interface GitHubTokenCapabilitySummary {
  login: string;
  tokenType: GitHubTokenType;
  hasRepoScope: boolean;
  hasWorkflowScope: boolean;
  scopeAmbiguous: boolean;
}

export interface CreateUserRepositoryInput {
  name: string;
  description: string;
  private: boolean;
  autoInit: boolean;
}

export interface CreateUserRepositoryResult {
  repositoryId: number;
  fullName: string;
  defaultBranch: string;
}

export interface GitBlobResult {
  sha: string;
}

export interface GitTreeEntryInput {
  path?: string;
  mode: string;
  type: "blob" | "tree";
  sha: string;
}

export interface GitTreeResult {
  sha: string;
}

export interface GitCommitResult {
  sha: string;
  tree: { sha: string };
  parents: Array<{ sha: string }>;
}

export interface GitRefResult {
  ref: string;
  object: { sha: string };
}

export interface CreateRepositoryFromTemplateInput {
  templateOwner: string;
  templateRepo: string;
  owner: string;
  name: string;
  description: string;
  private: boolean;
  includeAllBranches: boolean;
}

export interface CreateRepositoryFromTemplateResult {
  repositoryId: number;
  fullName: string;
  defaultBranch: string;
}

export interface RepositoryFileWriteInput {
  owner: string;
  repo: string;
  path: string;
  branch: string;
  message: string;
  content: string;
  sha?: string;
}

export interface GitHubHarnessProvisioningProvider {
  resolveAuthenticatedUser(): Promise<AuthenticatedGitHubUser>;
  inspectTokenCapabilities(): Promise<GitHubTokenCapabilitySummary>;
  getRepositoryMetadata(
    owner: string,
    repo: string,
  ): Promise<GitHubRepositoryMetadata | null>;
  getRepositoryMetadataById(
    repositoryId: number,
  ): Promise<GitHubRepositoryMetadata | null>;
  getRepositoryDefaultBranchHead(
    owner: string,
    repo: string,
    branch: string,
  ): Promise<string>;
  readRepositoryFileContent(
    owner: string,
    repo: string,
    path: string,
    ref: string,
  ): Promise<string | null>;
  createRepositoryFromTemplate(
    input: CreateRepositoryFromTemplateInput,
  ): Promise<CreateRepositoryFromTemplateResult>;
  createUserRepository(
    input: CreateUserRepositoryInput,
  ): Promise<CreateUserRepositoryResult>;
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
  updateUserRepositoryDescription(input: {
    owner: string;
    repo: string;
    description: string;
  }): Promise<void>;
  writeRepositoryFile(
    input: RepositoryFileWriteInput,
  ): Promise<{ commitSha: string }>;
  /**
   * Optional bulk git transport. When present, live provisioning pushes
   * snapshot+marker commits with one authenticated git push instead of
   * per-file createGitBlob REST mutations.
   */
  pushHarnessSnapshotCommits?(input: {
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
    timings: HarnessGitTransportTimings;
  }>;
}

export interface HarnessSecretWriteRequest {
  name: HarnessActionsSecretName;
  value: string;
}

export interface HarnessSecretWriteResultEntry {
  name: HarnessActionsSecretName;
  status: "created" | "updated";
}

export interface HarnessVariableWriteRequest {
  name: string;
  value: string;
}

export interface HarnessVariableWriteResultEntry {
  name: string;
  status: "created" | "updated";
}

export interface TargetWorkflowApplyInput {
  targetRepoSlug: string;
  productionBranch: string;
  branchName: string;
  workflowPath: string;
  workflowContent: string;
  prTitle: string;
  prBody: string;
}

export type TargetWorkflowApplyOutcome =
  | "already-installed"
  | "pr-created"
  | "pr-updated"
  | "branch-updated";

export interface TargetWorkflowApplyResult {
  outcome: TargetWorkflowApplyOutcome;
  branchName: string;
  prUrl?: string;
  directProductionBranchWrite: false;
}

export interface GitHubRemoteSetupProvider {
  checkHarnessRepoAccess(harnessDispatchRepo: string): Promise<RemoteAccessStatus>;
  listHarnessSecretStatuses(
    harnessDispatchRepo: string,
  ): Promise<HarnessSecretStatusEntry[]>;
  checkTargetWorkflowStatus(input: {
    targetRepoSlug: string;
    workflowPath: string;
    intendedWorkflowContent: string;
    productionBranch: string;
  }): Promise<{
    repoAccess: RemoteAccessStatus;
    workflowStatus: RemoteWorkflowStatus;
    productionBranchSha?: string;
  }>;
  writeHarnessSecrets(
    harnessDispatchRepo: string,
    secrets: HarnessSecretWriteRequest[],
  ): Promise<HarnessSecretWriteResultEntry[]>;
  writeHarnessVariables?(
    harnessDispatchRepo: string,
    variables: HarnessVariableWriteRequest[],
  ): Promise<HarnessVariableWriteResultEntry[]>;
  applyTargetWorkflowPr(
    input: TargetWorkflowApplyInput,
  ): Promise<TargetWorkflowApplyResult>;
}

export interface MockGitHubRemoteSetupProviderState {
  harnessRepoAccess?: RemoteAccessStatus;
  harnessSecretStatuses?: Partial<
    Record<HarnessActionsSecretName, HarnessSecretStatusEntry["status"]>
  >;
  targetRepoAccess?: RemoteAccessStatus;
  existingWorkflowContent?: string | null;
  productionBranchSha?: string;
  existingOpenPrUrl?: string;
  writeHarnessSecretsResult?: HarnessSecretWriteResultEntry[];
  writeHarnessVariablesResult?: HarnessVariableWriteResultEntry[];
  applyTargetWorkflowResult?: TargetWorkflowApplyResult;
  finalizationScenario?: MockWorkflowFinalizationScenario;
  harnessDispatchRepo?: HarnessDispatchRepoResolution;
}

export class MockGitHubRemoteSetupProvider implements GitHubRemoteSetupProvider {
  readonly calls: Array<{ method: string; args: unknown[] }> = [];
  readonly encryptedWrites: Array<{
    harnessDispatchRepo: string;
    secretName: string;
    encryptedValue: string;
  }> = [];
  private mutableWorkflowContent: string | null | undefined;

  constructor(private readonly state: MockGitHubRemoteSetupProviderState = {}) {
    this.mutableWorkflowContent = state.existingWorkflowContent;
  }

  advanceTargetWorkflowFinalization(
    input: TargetWorkflowFinalizeInput,
  ): TargetWorkflowFinalizationResult {
    this.calls.push({
      method: "advanceTargetWorkflowFinalization",
      args: [input],
    });

    const harnessDispatchRepo =
      this.state.harnessDispatchRepo ??
      ({
        resolved: true,
        repo: "owner/harness-repo",
        source: "explicit-config",
      } satisfies HarnessDispatchRepoResolution);
    const preview = previewTargetWorkflowSetup({
      repoConfigId: input.repoConfigId,
      targetRepo: input.targetRepo,
      productionBranch: input.productionBranch,
      harnessDispatchRepo,
    });

    return advanceMockTargetWorkflowFinalization({
      finalizeInput: input,
      intendedWorkflowContent: preview.workflowContent,
      existingWorkflowContent: this.mutableWorkflowContent,
      scenario: this.state.finalizationScenario,
      onProductionWorkflowUpdate: (content) => {
        this.mutableWorkflowContent = content;
      },
    });
  }

  setExistingWorkflowContent(content: string | null): void {
    this.mutableWorkflowContent = content;
  }

  async checkHarnessRepoAccess(
    harnessDispatchRepo: string,
  ): Promise<RemoteAccessStatus> {
    this.calls.push({
      method: "checkHarnessRepoAccess",
      args: [harnessDispatchRepo],
    });
    return this.state.harnessRepoAccess ?? "unknown";
  }

  async listHarnessSecretStatuses(
    harnessDispatchRepo: string,
  ): Promise<HarnessSecretStatusEntry[]> {
    this.calls.push({
      method: "listHarnessSecretStatuses",
      args: [harnessDispatchRepo],
    });

    return HARNESS_ACTIONS_SECRET_NAMES.map((name) => ({
      name,
      status: this.state.harnessSecretStatuses?.[name] ?? "unknown",
    }));
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
    this.calls.push({
      method: "checkTargetWorkflowStatus",
      args: [input],
    });

    const existing = this.mutableWorkflowContent ?? this.state.existingWorkflowContent;
    let workflowStatus: RemoteWorkflowStatus = "unknown";
    if (existing === null || existing === undefined) {
      workflowStatus = "missing";
    } else if (existing === input.intendedWorkflowContent) {
      workflowStatus = "present";
    } else {
      workflowStatus = "differs";
    }

    return {
      repoAccess: this.state.targetRepoAccess ?? "unknown",
      workflowStatus,
      productionBranchSha: this.state.productionBranchSha,
    };
  }

  async writeHarnessSecrets(
    harnessDispatchRepo: string,
    secrets: HarnessSecretWriteRequest[],
  ): Promise<HarnessSecretWriteResultEntry[]> {
    this.calls.push({
      method: "writeHarnessSecrets",
      args: [harnessDispatchRepo, secrets.map((entry) => entry.name)],
    });

    for (const secret of secrets) {
      this.encryptedWrites.push({
        harnessDispatchRepo,
        secretName: secret.name,
        encryptedValue: `encrypted:${secret.value.length}`,
      });
    }

    return (
      this.state.writeHarnessSecretsResult ??
      secrets.map((secret) => ({
        name: secret.name,
        status:
          this.state.harnessSecretStatuses?.[secret.name] === "present"
            ? "updated"
            : "created",
      }))
    );
  }

  async writeHarnessVariables(
    harnessDispatchRepo: string,
    variables: HarnessVariableWriteRequest[],
  ): Promise<HarnessVariableWriteResultEntry[]> {
    this.calls.push({
      method: "writeHarnessVariables",
      args: [harnessDispatchRepo, variables.map((entry) => entry.name)],
    });

    return (
      this.state.writeHarnessVariablesResult ??
      variables.map((variable) => ({
        name: variable.name,
        status: "created",
      }))
    );
  }

  async applyTargetWorkflowPr(
    input: TargetWorkflowApplyInput,
  ): Promise<TargetWorkflowApplyResult> {
    this.calls.push({
      method: "applyTargetWorkflowPr",
      args: [
        {
          ...input,
          workflowContent: `<redacted:${input.workflowContent.length}>`,
        },
      ],
    });

    if (input.branchName === input.productionBranch) {
      throw new Error("Direct production branch writes are not allowed");
    }

    if (this.state.applyTargetWorkflowResult) {
      return this.state.applyTargetWorkflowResult;
    }

    if (this.state.existingWorkflowContent === input.workflowContent) {
      return {
        outcome: "already-installed",
        branchName: input.branchName,
        directProductionBranchWrite: false,
      };
    }

    return {
      outcome: this.state.existingOpenPrUrl ? "pr-updated" : "pr-created",
      branchName: input.branchName,
      prUrl:
        this.state.existingOpenPrUrl ??
        `https://github.com/${input.targetRepoSlug}/pull/1`,
      directProductionBranchWrite: false,
    };
  }
}

export interface MockGitHubHarnessProvisioningProviderState {
  authenticatedUser?: AuthenticatedGitHubUser;
  tokenCapabilities?: GitHubTokenCapabilitySummary;
  repositories?: Record<
    string,
    GitHubRepositoryMetadata & {
      templateIdentityContent?: string | null;
      managedMarkerContent?: string | null;
      branchHeadSha?: string;
    }
  >;
  createRepositoryFromTemplateResult?: CreateRepositoryFromTemplateResult;
  createRepositoryFromTemplateError?: Error;
  deferDestinationTemplateIdentity?: boolean;
  markerCommitError?: Error | null;
  markerCommitErrorsRemaining?: number;
  writeRepositoryFileError?: Error | null;
  createdRepositoryDefaultBranch?: string;
  updateUserRepositoryDescriptionError?: Error | null;
  updateUserRepositoryDescriptionErrorsRemaining?: number;
  getRepositoryMetadataAttemptsBeforeVisible?: number;
  createUserRepositoryAmbiguous?: boolean;
  fileWrites?: Array<RepositoryFileWriteInput & { commitSha: string }>;
}

export function deterministicMockRepositoryId(slug: string): number {
  let hash = 0;
  for (let index = 0; index < slug.length; index += 1) {
    hash = (hash * 31 + slug.charCodeAt(index)) % 900_000_000;
  }
  return 100_000 + hash;
}

function withRepositoryId(
  slug: string,
  metadata: GitHubRepositoryMetadata & {
    templateIdentityContent?: string | null;
    managedMarkerContent?: string | null;
    branchHeadSha?: string;
  },
): GitHubRepositoryMetadata & {
  templateIdentityContent?: string | null;
  managedMarkerContent?: string | null;
  branchHeadSha?: string;
} {
  return {
    ...metadata,
    repositoryId:
      Number.isInteger(metadata.repositoryId) && metadata.repositoryId > 0
        ? metadata.repositoryId
        : deterministicMockRepositoryId(slug),
  };
}

export class MockGitHubHarnessProvisioningProvider
  implements GitHubHarnessProvisioningProvider
{
  readonly calls: Array<{ method: string; args: unknown[] }> = [];
  private repositories: Record<
    string,
    GitHubRepositoryMetadata & {
      templateIdentityContent?: string | null;
      managedMarkerContent?: string | null;
      branchHeadSha?: string;
    }
  >;
  private readonly gitStores = new Map<string, MockGitRepositoryStore>();
  private repositoryMetadataVisibilityAttempts = 0;

  constructor(
    private readonly state: MockGitHubHarnessProvisioningProviderState = {},
  ) {
    this.repositories = Object.fromEntries(
      Object.entries(state.repositories ?? {}).map(([slug, metadata]) => [
        slug,
        withRepositoryId(slug, metadata),
      ]),
    );
  }

  async resolveAuthenticatedUser(): Promise<AuthenticatedGitHubUser> {
    this.calls.push({ method: "resolveAuthenticatedUser", args: [] });
    return (
      this.state.authenticatedUser ?? {
        id: 1,
        login: "test-user",
      }
    );
  }

  async inspectTokenCapabilities(): Promise<GitHubTokenCapabilitySummary> {
    this.calls.push({ method: "inspectTokenCapabilities", args: [] });
    return (
      this.state.tokenCapabilities ?? {
        login: "test-user",
        tokenType: "classic",
        hasRepoScope: true,
        hasWorkflowScope: true,
        scopeAmbiguous: false,
      }
    );
  }

  clearProvisioningFaults(): void {
    this.state.markerCommitError = null;
    this.state.markerCommitErrorsRemaining = undefined;
    this.state.updateUserRepositoryDescriptionError = null;
    this.state.updateUserRepositoryDescriptionErrorsRemaining = undefined;
    this.repositoryMetadataVisibilityAttempts = 0;
  }

  async dispose(): Promise<void> {
    for (const store of this.gitStores.values()) {
      await store.destroy();
    }
    this.gitStores.clear();
  }

  async getRepositoryMetadata(
    owner: string,
    repo: string,
  ): Promise<GitHubRepositoryMetadata | null> {
    this.calls.push({ method: "getRepositoryMetadata", args: [owner, repo] });
    const key = `${owner}/${repo}`;
    const entry = this.repositories[key];
    if (!entry) {
      return null;
    }
    const requiredAttempts = this.state.getRepositoryMetadataAttemptsBeforeVisible ?? 0;
    if (requiredAttempts > 0) {
      this.repositoryMetadataVisibilityAttempts += 1;
      if (this.repositoryMetadataVisibilityAttempts < requiredAttempts) {
        return null;
      }
    }
    return {
      repositoryId: entry.repositoryId,
      owner: entry.owner,
      repo: entry.repo,
      description: entry.description ?? null,
      private: entry.private,
      visibility: entry.visibility,
      isTemplate: entry.isTemplate,
      defaultBranch: entry.defaultBranch,
      permissions: entry.permissions,
    };
  }

  async getRepositoryMetadataById(
    repositoryId: number,
  ): Promise<GitHubRepositoryMetadata | null> {
    this.calls.push({
      method: "getRepositoryMetadataById",
      args: [repositoryId],
    });
    for (const entry of Object.values(this.repositories)) {
      if (entry.repositoryId === repositoryId) {
        const {
          templateIdentityContent: _t,
          managedMarkerContent: _m,
          branchHeadSha: _b,
          ...metadata
        } = entry;
        return metadata;
      }
    }
    return null;
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
    const key = `${owner}/${repo}`;
    const store = this.gitStores.get(key);
    if (store) {
      return store.getHeadSha();
    }
    return this.repositories[key]?.branchHeadSha ?? "abc123templatehead";
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
    const key = `${owner}/${repo}`;
    const entry = this.repositories[key];
    if (!entry) {
      return null;
    }

    const store = this.gitStores.get(key);
    if (store) {
      const commit = store.getCommit(ref);
      if (commit) {
        const content = store.readFileAtCommit(ref, path);
        return content ? content.toString("utf8") : null;
      }
    }

    if (path.endsWith("p-dev-template.json")) {
      return entry.templateIdentityContent ?? null;
    }
    if (path.endsWith("p-dev-managed-repo.json")) {
      return entry.managedMarkerContent ?? null;
    }
    return null;
  }

  async createRepositoryFromTemplate(
    input: CreateRepositoryFromTemplateInput,
  ): Promise<CreateRepositoryFromTemplateResult> {
    this.calls.push({ method: "createRepositoryFromTemplate", args: [input] });
    if (this.state.createRepositoryFromTemplateError) {
      throw this.state.createRepositoryFromTemplateError;
    }
    const result =
      this.state.createRepositoryFromTemplateResult ?? {
        repositoryId: deterministicMockRepositoryId(`${input.owner}/${input.name}`),
        fullName: `${input.owner}/${input.name}`,
        defaultBranch: "main",
      };
    const key = result.fullName;
    const templateSource =
      this.repositories[`${input.templateOwner}/${input.templateRepo}`]
        ?.templateIdentityContent ?? null;
    this.repositories[key] = withRepositoryId(key, {
      owner: input.owner,
      repo: input.name,
      repositoryId: result.repositoryId,
      private: input.private,
      visibility: input.private ? "private" : "public",
      isTemplate: false,
      defaultBranch: result.defaultBranch,
      permissions: { admin: true, maintain: true, push: true },
      templateIdentityContent: this.state.deferDestinationTemplateIdentity
        ? null
        : templateSource,
      managedMarkerContent: null,
      branchHeadSha: "generatedheadsha",
    });
    return result;
  }

  private async ensureGitStore(key: string): Promise<MockGitRepositoryStore> {
    const existing = this.gitStores.get(key);
    if (existing) {
      return existing;
    }
    const store = await createMockGitRepositoryStore();
    this.gitStores.set(key, store);
    const entry = this.repositories[key];
    if (entry) {
      entry.branchHeadSha = store.getHeadSha();
    }
    return store;
  }

  async updateUserRepositoryDescription(input: {
    owner: string;
    repo: string;
    description: string;
  }): Promise<void> {
    this.calls.push({ method: "updateUserRepositoryDescription", args: [input] });
    if (this.state.updateUserRepositoryDescriptionError) {
      if (
        this.state.updateUserRepositoryDescriptionErrorsRemaining === undefined ||
        this.state.updateUserRepositoryDescriptionErrorsRemaining > 0
      ) {
        if (this.state.updateUserRepositoryDescriptionErrorsRemaining !== undefined) {
          this.state.updateUserRepositoryDescriptionErrorsRemaining -= 1;
        }
        throw this.state.updateUserRepositoryDescriptionError;
      }
    }
    const key = `${input.owner}/${input.repo}`;
    const entry = this.repositories[key];
    if (entry) {
      entry.description = input.description;
    }
  }

  async createUserRepository(
    input: CreateUserRepositoryInput,
  ): Promise<CreateUserRepositoryResult> {
    this.calls.push({ method: "createUserRepository", args: [input] });
    const login =
      this.state.authenticatedUser?.login?.trim() ||
      this.state.tokenCapabilities?.login?.trim() ||
      "test-user";
    const fullName = `${login}/${input.name}`;
    const key = fullName;
    const repositoryId = deterministicMockRepositoryId(key);
    const defaultBranch = this.state.createdRepositoryDefaultBranch ?? "main";
    this.repositories[key] = withRepositoryId(key, {
      owner: login,
      repo: input.name,
      repositoryId,
      description: input.description,
      private: input.private,
      visibility: input.private ? "private" : "public",
      isTemplate: false,
      defaultBranch,
      permissions: { admin: true, maintain: true, push: true },
      templateIdentityContent: null,
      managedMarkerContent: null,
      branchHeadSha: "",
    });
    if (input.autoInit) {
      await this.ensureGitStore(key);
    }
    if (this.state.createUserRepositoryAmbiguous) {
      throw new GitHubApiError(422, "Repository creation returned an ambiguous result.");
    }
    return {
      repositoryId,
      fullName: key,
      defaultBranch,
    };
  }

  async createGitBlob(input: {
    owner: string;
    repo: string;
    content: Buffer;
  }): Promise<GitBlobResult> {
    this.calls.push({
      method: "createGitBlob",
      args: [{ owner: input.owner, repo: input.repo, bytes: input.content.byteLength }],
    });
    const key = `${input.owner}/${input.repo}`;
    const store = await this.ensureGitStore(key);
    const sha = store.createBlob(input.content);
    return { sha };
  }

  async createGitTree(input: {
    owner: string;
    repo: string;
    baseTree?: string;
    tree: GitTreeEntryInput[];
  }): Promise<GitTreeResult> {
    this.calls.push({ method: "createGitTree", args: [input] });
    const key = `${input.owner}/${input.repo}`;
    const store = await this.ensureGitStore(key);
    const entries = input.tree.map((treeEntry) => ({
      path: treeEntry.path ?? "",
      mode: treeEntry.mode,
      sha: treeEntry.sha,
    }));
    const sha = input.baseTree
      ? store.createTreeWithBase(entries, input.baseTree)
      : store.createTreeFromFlatEntries(entries);
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
    this.calls.push({ method: "createGitCommit", args: [input] });
    if (/managed harness workspace marker/i.test(input.message)) {
      if (this.state.markerCommitError) {
        throw this.state.markerCommitError;
      }
      if (
        this.state.markerCommitErrorsRemaining !== undefined &&
        this.state.markerCommitErrorsRemaining > 0
      ) {
        this.state.markerCommitErrorsRemaining -= 1;
        throw new Error("marker commit failed");
      }
    }
    const key = `${input.owner}/${input.repo}`;
    const store = await this.ensureGitStore(key);
    const sha = store.createCommitRecord({
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
    const key = `${owner}/${repo}`;
    const store = await this.ensureGitStore(key);
    const commit = store.getCommit(sha);
    if (!commit) {
      throw new Error(`Mock git commit ${sha} not found.`);
    }
    return {
      sha,
      tree: { sha: commit.treeSha },
      parents: commit.parents.map((parent) => ({ sha: parent })),
    };
  }

  async getGitRef(owner: string, repo: string, ref: string): Promise<GitRefResult> {
    this.calls.push({ method: "getGitRef", args: [owner, repo, ref] });
    const key = `${owner}/${repo}`;
    const store = await this.ensureGitStore(key);
    return {
      ref: `refs/heads/${ref}`,
      object: { sha: store.getHeadSha() },
    };
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
      throw new Error("Force ref updates are not allowed in mock provisioning.");
    }
    const key = `${input.owner}/${input.repo}`;
    const entry = this.repositories[key];
    const store = await this.ensureGitStore(key);
    const currentHead = store.getHeadSha();
    if (currentHead === input.sha) {
      return {
        ref: `refs/heads/${input.ref}`,
        object: { sha: input.sha },
      };
    }
    if (input.expectedSha && currentHead !== input.expectedSha) {
      throw new Error(
        `Ref update rejected: expected HEAD ${input.expectedSha}, found ${currentHead}.`,
      );
    }
    const commit = store.getCommit(input.sha);
    if (!commit) {
      throw new Error(`Cannot fast-forward to unknown commit ${input.sha}.`);
    }
    if (currentHead !== input.sha && !commit.parents.includes(currentHead)) {
      throw new Error(
        `Ref update rejected: ${input.sha} is not a descendant of ${currentHead}.`,
      );
    }
    store.updateRef(input.sha, input.expectedSha);
    if (entry) {
      entry.branchHeadSha = input.sha;
    }
    return {
      ref: `refs/heads/${input.ref}`,
      object: { sha: input.sha },
    };
  }

  revealDestinationTemplateIdentity(
    slug: string,
    templateIdentityContent: string,
  ): void {
    const entry = this.repositories[slug];
    if (entry) {
      entry.templateIdentityContent = templateIdentityContent;
    }
  }

  async writeRepositoryFile(
    input: RepositoryFileWriteInput,
  ): Promise<{ commitSha: string }> {
    this.calls.push({ method: "writeRepositoryFile", args: [input] });
    if (this.state.writeRepositoryFileError) {
      const error = this.state.writeRepositoryFileError;
      this.state.writeRepositoryFileError = null;
      throw error;
    }
    const key = `${input.owner}/${input.repo}`;
    const entry = this.repositories[key];
    if (entry && input.path.endsWith("p-dev-managed-repo.json")) {
      entry.managedMarkerContent = input.content;
      const extended = entry as typeof entry & { fileContents?: Record<string, string> };
      extended.fileContents ??= {};
      extended.fileContents[input.path] = input.content;
    }
    const commitSha = `commit-${this.state.fileWrites?.length ?? 0}`;
    this.state.fileWrites = [
      ...(this.state.fileWrites ?? []),
      { ...input, commitSha },
    ];
    return { commitSha };
  }

  setRepository(
    slug: string,
    metadata: GitHubRepositoryMetadata & {
      templateIdentityContent?: string | null;
      managedMarkerContent?: string | null;
      branchHeadSha?: string;
    },
  ): void {
    this.repositories[slug] = withRepositoryId(slug, metadata);
  }
}

export function mapGitHubSecretMetadataToStatus(
  secretNames: readonly string[],
  knownSecretNames: readonly HarnessActionsSecretName[],
): HarnessSecretStatusEntry[] {
  const known = new Set(secretNames);
  return knownSecretNames.map((name) => ({
    name,
    status: known.has(name) ? "present" : "missing",
  }));
}

export function mapGitHubAccessErrorToStatus(statusCode: number): RemoteAccessStatus {
  if (statusCode === 401 || statusCode === 403) {
    return "denied";
  }
  if (statusCode === 404) {
    return "denied";
  }
  return "unknown";
}
