import { readFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { GitHubApiError } from "../github/client.js";
import { isGitHubRateLimitError } from "../github/rate-limit-metadata.js";
import { HARNESS_MANAGED_REPO_MARKER_FILE } from "./harness-managed-repo-marker.js";
import {
  buildHarnessSnapshotManagedRepoMarker,
  parseHarnessManagedRepoMarkerJson,
} from "./harness-managed-repo-marker.js";
import type { GitHubHarnessProvisioningProvider } from "./github-remote-provider.js";
import { parseRepoSlug } from "./github-remote-setup-live.js";
import type { HarnessProvisioningPendingState } from "./harness-provisioning-pending-state.js";
import type { WorkspaceSnapshotManifest } from "../p-dev/workspace-snapshot-types.js";
import { loadWorkspaceSnapshotEntryContent } from "../p-dev/workspace-snapshot-generator.js";
import {
  buildProvisioningRepositoryDescription,
  deriveProvisioningCommitIdentity,
  isProvisioningOperationDescription,
  SnapshotProvisioningError,
} from "./harness-snapshot-provisioning-helpers.js";
import { GitHubUploadRateLimitGate } from "./github-upload-rate-limit-gate.js";
import {
  resolveGitPushTimeoutMs,
  type HarnessGitTransportTimings,
} from "./harness-snapshot-git-transport.js";

export { SnapshotProvisioningError };

async function withPhaseTimeout<T>(
  phase: SnapshotProvisioningPhase,
  timeoutMs: number,
  fn: () => Promise<T>,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      fn(),
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          reject(
            new SnapshotProvisioningError(
              "remote-phase-timeout",
              `Provisioning phase "${phase}" timed out after ${timeoutMs}ms. Retry Step 1 Continue to resume or reconcile.`,
              true,
            ),
          );
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

const DEFAULT_UPLOAD_CONCURRENCY = resolveSnapshotUploadConcurrency();
const MAX_UPLOAD_RETRIES = Number(process.env.HARNESS_SNAPSHOT_UPLOAD_RETRIES ?? 3);
const RECONCILE_REPOSITORY_ATTEMPTS_DEFAULT = 5;
const RECONCILE_REPOSITORY_INITIAL_DELAY_MS_DEFAULT = 500;

export function resolveSnapshotUploadConcurrency(
  raw = process.env.HARNESS_SNAPSHOT_UPLOAD_CONCURRENCY,
): number {
  if (raw === undefined || raw.trim() === "") {
    return 2;
  }
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(
      "Invalid HARNESS_SNAPSHOT_UPLOAD_CONCURRENCY: must be an integer between 1 and 4.",
    );
  }
  const parsed = Number(trimmed);
  if (parsed < 1 || parsed > 4) {
    throw new Error(
      "Invalid HARNESS_SNAPSHOT_UPLOAD_CONCURRENCY: must be between 1 and 4.",
    );
  }
  return parsed;
}

export function getDefaultSnapshotUploadConcurrency(): number {
  return DEFAULT_UPLOAD_CONCURRENCY;
}

function reconcilePollingConfig(): {
  attempts: number;
  initialDelayMs: number;
} {
  return {
    attempts: Number(
      process.env.HARNESS_SNAPSHOT_RECONCILE_ATTEMPTS ??
        RECONCILE_REPOSITORY_ATTEMPTS_DEFAULT,
    ),
    initialDelayMs: Number(
      process.env.HARNESS_SNAPSHOT_RECONCILE_DELAY_MS ??
        RECONCILE_REPOSITORY_INITIAL_DELAY_MS_DEFAULT,
    ),
  };
}

export type SnapshotProvisioningPhase =
  | "repository-created"
  | "preparing-snapshot"
  | "snapshot-objects-uploading"
  | "workspace-uploading"
  | "snapshot-commit-created"
  | "marker-pending"
  | "verifying"
  | "description-pending"
  | "persistence-pending";

export interface SnapshotProvisioningProgress {
  phase: SnapshotProvisioningProgressPhase;
  uploadedBlobs: number;
  totalBlobs: number;
  completed?: number;
  total?: number;
  rateLimitPauseSeconds?: number;
  lastSafeCheckpoint?: string;
}

export type SnapshotProvisioningProgressPhase = SnapshotProvisioningPhase;

export interface SnapshotProvisioningCheckpoint
  extends Partial<HarnessProvisioningPendingState> {
  phase: SnapshotProvisioningPhase;
}

export interface SnapshotProvisioningTimings {
  repositoryCreateReconcileMs?: number;
  workspaceUploadMs?: number;
  descriptionFinalizationMs?: number;
  gitTransport?: HarnessGitTransportTimings;
}

function elapsedProvisioningMs(startedAt: number): number {
  return Math.round(performance.now() - startedAt);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface ProvisioningRetryContext {
  gate: GitHubUploadRateLimitGate;
  onRateLimitPause?: (pauseSeconds: number, phase: SnapshotProvisioningPhase) => void;
}

export function createProvisioningRetryContext(input?: {
  onRateLimitPause?: (pauseSeconds: number, phase: SnapshotProvisioningPhase) => void;
}): ProvisioningRetryContext {
  return {
    gate: new GitHubUploadRateLimitGate(),
    onRateLimitPause: input?.onRateLimitPause,
  };
}

export function isRetryableGitHubError(error: unknown): boolean {
  if (!(error instanceof GitHubApiError)) {
    return false;
  }
  if (isGitHubRateLimitError(error)) {
    return true;
  }
  return error.status === 408 || error.status >= 500;
}

async function withRetries<T>(
  fn: () => Promise<T>,
  retryContext: ProvisioningRetryContext,
  phase: SnapshotProvisioningPhase,
): Promise<T> {
  let attempt = 0;
  while (true) {
    await retryContext.gate.waitBeforeMutation();
    try {
      return await fn();
    } catch (error) {
      attempt += 1;
      if (!(error instanceof GitHubApiError)) {
        throw error;
      }
      if (isGitHubRateLimitError(error)) {
        const delayMs = retryContext.gate.recordRateLimitFailure(error);
        retryContext.onRateLimitPause?.(Math.ceil(delayMs / 1_000), phase);
        if (attempt > MAX_UPLOAD_RETRIES) {
          throw error;
        }
        continue;
      }
      if (isRetryableGitHubError(error) && attempt <= MAX_UPLOAD_RETRIES) {
        const delayMs = Math.min(8_000, 250 * 2 ** (attempt - 1));
        await sleep(delayMs + Math.floor(Math.random() * 100));
        continue;
      }
      throw error;
    }
  }
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.max(1, concurrency) }, async () => {
    while (true) {
      const current = nextIndex;
      nextIndex += 1;
      if (current >= items.length) {
        return;
      }
      results[current] = await mapper(items[current]!, current);
    }
  });
  await Promise.all(workers);
  return results;
}

export async function uploadSnapshotBlobs(input: {
  provider: GitHubHarnessProvisioningProvider;
  owner: string;
  repo: string;
  snapshotRoot: string;
  manifest: WorkspaceSnapshotManifest;
  retryContext: ProvisioningRetryContext;
  onProgress?: (progress: SnapshotProvisioningProgress) => void;
}): Promise<Map<string, string>> {
  const blobShaByPath = new Map<string, string>();
  const files = input.manifest.files;
  input.onProgress?.({
    phase: "snapshot-objects-uploading",
    uploadedBlobs: 0,
    totalBlobs: files.length,
  });

  let uploaded = 0;
  await mapWithConcurrency(
    files,
    DEFAULT_UPLOAD_CONCURRENCY,
    async (file) => {
      const content = await loadWorkspaceSnapshotEntryContent({
        snapshotRoot: input.snapshotRoot,
        path: file.path,
        expectedSha256: file.sha256,
      });
      const blob = await withRetries(
        () =>
          input.provider.createGitBlob({
            owner: input.owner,
            repo: input.repo,
            content,
          }),
        input.retryContext,
        "snapshot-objects-uploading",
      );
      if (blob.sha !== file.gitBlobSha1) {
        throw new Error(
          `Uploaded blob SHA mismatch for ${file.path} (expected ${file.gitBlobSha1}, got ${blob.sha}).`,
        );
      }
      blobShaByPath.set(file.path, blob.sha);
      uploaded += 1;
      input.onProgress?.({
        phase: "snapshot-objects-uploading",
        uploadedBlobs: uploaded,
        totalBlobs: files.length,
      });
    },
  );

  return blobShaByPath;
}

export async function createSnapshotCommit(input: {
  provider: GitHubHarnessProvisioningProvider;
  owner: string;
  repo: string;
  manifest: WorkspaceSnapshotManifest;
  parentCommitSha: string;
  operationId: string;
  blobShaByPath: Map<string, string>;
  retryContext: ProvisioningRetryContext;
}): Promise<string> {
  const commitIdentity = deriveProvisioningCommitIdentity({
    operationId: input.operationId,
    sourceCommit: input.manifest.sourceCommit,
  });
  const tree = await withRetries(
    () =>
      input.provider.createGitTree({
        owner: input.owner,
        repo: input.repo,
        tree: input.manifest.files.map((file) => ({
          path: file.path,
          mode: file.mode,
          type: "blob" as const,
          sha: input.blobShaByPath.get(file.path) ?? file.gitBlobSha1,
        })),
      }),
    input.retryContext,
    "snapshot-commit-created",
  );
  if (tree.sha !== input.manifest.gitRootTreeSha1) {
    throw new SnapshotProvisioningError(
      "snapshot-tree-mismatch",
      `Snapshot tree SHA mismatch (expected ${input.manifest.gitRootTreeSha1}, got ${tree.sha}).`,
      false,
    );
  }
  const commit = await withRetries(
    () =>
      input.provider.createGitCommit({
        owner: input.owner,
        repo: input.repo,
        message: `Initialize p-dev harness workspace snapshot (${input.manifest.packageVersion})`,
        tree: tree.sha,
        parents: [input.parentCommitSha],
        author: commitIdentity,
        committer: commitIdentity,
      }),
    input.retryContext,
    "snapshot-commit-created",
  );
  return commit.sha;
}

export async function createMarkerCommit(input: {
  provider: GitHubHarnessProvisioningProvider;
  owner: string;
  repo: string;
  defaultBranch: string;
  parentCommitSha: string;
  snapshotTreeSha: string;
  markerContent: string;
  operationId: string;
  sourceCommit: string;
  retryContext: ProvisioningRetryContext;
}): Promise<string> {
  const commitIdentity = deriveProvisioningCommitIdentity({
    operationId: input.operationId,
    sourceCommit: input.sourceCommit,
  });
  const markerBlob = await withRetries(
    () =>
      input.provider.createGitBlob({
        owner: input.owner,
        repo: input.repo,
        content: Buffer.from(input.markerContent, "utf8"),
      }),
    input.retryContext,
    "marker-pending",
  );
  const markerTree = await withRetries(
    () =>
      input.provider.createGitTree({
        owner: input.owner,
        repo: input.repo,
        baseTree: input.snapshotTreeSha,
        tree: [
          {
            path: HARNESS_MANAGED_REPO_MARKER_FILE,
            mode: "100644",
            type: "blob",
            sha: markerBlob.sha,
          },
        ],
      }),
    input.retryContext,
    "marker-pending",
  );
  if (markerTree.sha === input.snapshotTreeSha) {
    throw new SnapshotProvisioningError(
      "marker-commit-failed",
      "Marker tree must overlay the snapshot tree rather than replace it.",
      false,
    );
  }
  const markerCommit = await withRetries(
    () =>
      input.provider.createGitCommit({
        owner: input.owner,
        repo: input.repo,
        message: "Initialize p-dev managed harness workspace marker",
        tree: markerTree.sha,
        parents: [input.parentCommitSha],
        author: commitIdentity,
        committer: commitIdentity,
      }),
    input.retryContext,
    "marker-pending",
  ).catch((error) => {
    throw new SnapshotProvisioningError(
      "marker-commit-failed",
      error instanceof Error ? error.message : "Marker commit creation failed.",
      true,
    );
  });
  const currentRef = await input.provider.getGitRef(
    input.owner,
    input.repo,
    input.defaultBranch,
  );
  if (currentRef.object.sha === markerCommit.sha) {
    return markerCommit.sha;
  }
  await withRetries(
    () =>
      input.provider.updateGitRef({
        owner: input.owner,
        repo: input.repo,
        ref: input.defaultBranch,
        sha: markerCommit.sha,
        force: false,
        expectedSha: input.parentCommitSha,
      }),
    input.retryContext,
    "marker-pending",
  );
  return markerCommit.sha;
}

async function reconcileCreatedRepositoryOnce(input: {
  provider: GitHubHarnessProvisioningProvider;
  owner: string;
  repoName: string;
  operationId: string;
}): Promise<{
  repositoryId: number;
  defaultBranch: string;
  initializedCommitSha: string;
} | null> {
  const metadata = await input.provider.getRepositoryMetadata(
    input.owner,
    input.repoName,
  );
  if (!metadata) {
    return null;
  }
  if (
    !metadata.private ||
    !metadata.permissions.admin ||
    metadata.owner !== input.owner ||
    metadata.repo !== input.repoName
  ) {
    return null;
  }
  if (!isProvisioningOperationDescription(metadata.description, input.operationId)) {
    return null;
  }
  const headSha = await input.provider.getRepositoryDefaultBranchHead(
    input.owner,
    input.repoName,
    metadata.defaultBranch,
  );
  return {
    repositoryId: metadata.repositoryId,
    defaultBranch: metadata.defaultBranch,
    initializedCommitSha: headSha,
  };
}

async function reconcileCreatedRepository(input: {
  provider: GitHubHarnessProvisioningProvider;
  owner: string;
  repoName: string;
  operationId: string;
}): Promise<{
  repositoryId: number;
  defaultBranch: string;
  initializedCommitSha: string;
} | null> {
  const { attempts, initialDelayMs } = reconcilePollingConfig();
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const reconciled = await reconcileCreatedRepositoryOnce(input);
    if (reconciled) {
      return reconciled;
    }
    if (attempt < attempts - 1) {
      const delayMs =
        initialDelayMs * 2 ** attempt + Math.floor(Math.random() * 100);
      await sleep(delayMs);
    }
  }
  return null;
}

async function finalizeProvisioningRepositoryDescription(input: {
  provider: GitHubHarnessProvisioningProvider;
  owner: string;
  repo: string;
  operationId: string;
  normalDescription: string;
  markerCommitSha: string;
  defaultBranch: string;
}): Promise<void> {
  const metadata = await input.provider.getRepositoryMetadata(input.owner, input.repo);
  if (!metadata) {
    throw new SnapshotProvisioningError(
      "description-finalization-failed",
      "Destination repository is not accessible for description finalization.",
      true,
    );
  }
  const headSha = await input.provider.getRepositoryDefaultBranchHead(
    input.owner,
    input.repo,
    input.defaultBranch,
  );
  if (headSha !== input.markerCommitSha) {
    throw new SnapshotProvisioningError(
      "description-finalization-failed",
      "Marker commit is not at branch HEAD; refusing to finalize repository description.",
      true,
    );
  }
  const currentDescription = metadata.description ?? "";
  if (currentDescription === input.normalDescription) {
    return;
  }
  if (!isProvisioningOperationDescription(currentDescription, input.operationId)) {
    throw new SnapshotProvisioningError(
      "description-finalization-failed",
      "Repository description does not match the expected operation ownership marker.",
      false,
    );
  }
  try {
    await input.provider.updateUserRepositoryDescription({
      owner: input.owner,
      repo: input.repo,
      description: input.normalDescription,
    });
  } catch (error) {
    throw new SnapshotProvisioningError(
      "description-finalization-failed",
      error instanceof Error ? error.message : "Description finalization failed.",
      true,
    );
  }
}

export async function verifyPendingRepositoryIdentity(input: {
  provider: GitHubHarnessProvisioningProvider;
  pending: HarnessProvisioningPendingState;
  manifest: WorkspaceSnapshotManifest;
}): Promise<{ ok: true } | { ok: false; message: string }> {
  if (!input.pending.repositoryId) {
    return { ok: false, message: "Pending state is missing repository ID." };
  }
  const metadata = await input.provider.getRepositoryMetadata(
    input.pending.targetOwner,
    input.pending.targetRepo,
  );
  if (!metadata) {
    return {
      ok: false,
      message: "Pending destination repository no longer exists.",
    };
  }
  if (metadata.repositoryId !== input.pending.repositoryId) {
    return {
      ok: false,
      message: "Pending destination repository ID does not match remote repository.",
    };
  }
  if (
    metadata.owner !== input.pending.targetOwner ||
    metadata.repo !== input.pending.targetRepo
  ) {
    return {
      ok: false,
      message: "Pending destination repository slug does not match remote repository.",
    };
  }
  if (!metadata.private || !metadata.permissions.admin) {
    return {
      ok: false,
      message: "Pending destination repository is not private/admin-accessible.",
    };
  }
  if (
    input.pending.defaultBranch &&
    metadata.defaultBranch !== input.pending.defaultBranch
  ) {
    return {
      ok: false,
      message: "Pending destination repository default branch does not match remote repository.",
    };
  }
  const defaultBranch = input.pending.defaultBranch ?? metadata.defaultBranch;
  const headSha = await input.provider.getRepositoryDefaultBranchHead(
    metadata.owner,
    metadata.repo,
    defaultBranch,
  );
  if (input.pending.markerCommitSha && headSha !== input.pending.markerCommitSha) {
    if (
      input.pending.snapshotCommitSha &&
      headSha !== input.pending.snapshotCommitSha &&
      input.pending.initializedCommitSha &&
      headSha !== input.pending.initializedCommitSha
    ) {
      return {
        ok: false,
        message: "Pending destination repository HEAD does not match recorded phase.",
      };
    }
  }
  if (input.pending.snapshotCommitSha) {
    const snapshotCommit = await input.provider.getGitCommit(
      metadata.owner,
      metadata.repo,
      input.pending.snapshotCommitSha,
    );
    if (snapshotCommit.tree.sha !== input.manifest.gitRootTreeSha1) {
      return {
        ok: false,
        message: "Recorded snapshot commit tree does not match embedded manifest.",
      };
    }
    if (
      input.pending.initializedCommitSha &&
      snapshotCommit.parents[0]?.sha !== input.pending.initializedCommitSha
    ) {
      return {
        ok: false,
        message: "Recorded snapshot commit parent does not match initialized commit.",
      };
    }
  }
  if (input.pending.markerCommitSha && input.pending.snapshotCommitSha) {
    const markerCommit = await input.provider.getGitCommit(
      metadata.owner,
      metadata.repo,
      input.pending.markerCommitSha,
    );
    if (markerCommit.parents[0]?.sha !== input.pending.snapshotCommitSha) {
      return {
        ok: false,
        message: "Recorded marker commit parent does not match snapshot commit.",
      };
    }
  }
  return { ok: true };
}

export async function provisionHarnessWorkspaceFromSnapshot(input: {
  provider: GitHubHarnessProvisioningProvider;
  user: { id: number; login: string };
  repoName: string;
  description: string;
  snapshotRoot: string;
  manifest: WorkspaceSnapshotManifest;
  packageVersion: string;
  operationId: string;
  pending?: HarnessProvisioningPendingState | null;
  onProgress?: (progress: SnapshotProvisioningProgress) => void;
  onCheckpoint?: (checkpoint: SnapshotProvisioningCheckpoint) => Promise<void>;
}): Promise<
  | {
      ok: true;
      fullName: string;
      repositoryId: number;
      defaultBranch: string;
      initializedCommitSha: string;
      snapshotCommitSha: string;
      markerCommitSha: string;
      timings: SnapshotProvisioningTimings;
    }
  | { ok: false; message: string; recoverable: boolean; code?: SnapshotProvisioningError["code"] }
> {
  const owner = input.user.login;
  const { repo } = parseRepoSlug(`${owner}/${input.repoName}`);
  const retryContext = createProvisioningRetryContext({
    onRateLimitPause: (pauseSeconds, phase) => {
      input.onProgress?.({
        phase,
        uploadedBlobs: input.pending?.snapshotCommitSha
          ? input.manifest.fileCount
          : 0,
        totalBlobs: input.manifest.fileCount,
        rateLimitPauseSeconds: pauseSeconds,
      });
    },
  });
  const timings: SnapshotProvisioningTimings = {};
  const repositoryCreateReconcileStartedAt = performance.now();

  if (input.pending?.repositoryId) {
    const identity = await verifyPendingRepositoryIdentity({
      provider: input.provider,
      pending: input.pending,
      manifest: input.manifest,
    });
    if (!identity.ok) {
      return { ok: false, message: identity.message, recoverable: false, code: "repository-identity-mismatch" };
    }
  }

  let repositoryId = input.pending?.repositoryId;
  let defaultBranch = input.pending?.defaultBranch;
  let initializedCommitSha = input.pending?.initializedCommitSha;

  if (repositoryId && initializedCommitSha && !defaultBranch) {
    const metadata = await input.provider.getRepositoryMetadata(owner, repo);
    if (metadata) {
      defaultBranch = metadata.defaultBranch;
    }
  }

  if (!repositoryId || !initializedCommitSha) {
    const operationDescription = buildProvisioningRepositoryDescription(
      input.description,
      input.operationId,
    );
    let created:
      | {
          repositoryId: number;
          defaultBranch: string;
          initializedCommitSha: string;
        }
      | undefined;
    try {
      const result = await input.provider.createUserRepository({
        name: input.repoName,
        description: operationDescription,
        private: true,
        autoInit: true,
      });
      const headRef = await input.provider.getGitRef(owner, repo, result.defaultBranch);
      created = {
        repositoryId: result.repositoryId,
        defaultBranch: result.defaultBranch,
        initializedCommitSha: headRef.object.sha,
      };
    } catch (error) {
      if (isRetryableGitHubError(error)) {
        const reconciled = await reconcileCreatedRepository({
          provider: input.provider,
          owner,
          repoName: input.repoName,
          operationId: input.operationId,
        });
        if (reconciled) {
          created = reconciled;
        } else {
          throw error;
        }
      } else if (error instanceof GitHubApiError && error.status === 422) {
        const reconciled = await reconcileCreatedRepository({
          provider: input.provider,
          owner,
          repoName: input.repoName,
          operationId: input.operationId,
        });
        if (!reconciled) {
          return {
            ok: false,
            message:
              "Repository creation returned an ambiguous result and no matching operation-owned repository was found.",
            recoverable: true,
            code: "repository-create-ambiguous",
          };
        }
        created = reconciled;
      } else {
        throw error;
      }
    }
    repositoryId = created.repositoryId;
    defaultBranch = created.defaultBranch;
    initializedCommitSha = created.initializedCommitSha;
    await input.onCheckpoint?.({
      phase: "repository-created",
      repositoryId,
      defaultBranch,
      initializedCommitSha,
    });
    input.onProgress?.({
      phase: "repository-created",
      uploadedBlobs: 0,
      totalBlobs: input.manifest.fileCount,
    });
  }
  timings.repositoryCreateReconcileMs = elapsedProvisioningMs(
    repositoryCreateReconcileStartedAt,
  );

  if (!defaultBranch) {
    return {
      ok: false,
      message: "Provisioning state is missing the repository default branch.",
      recoverable: false,
      code: "repository-identity-mismatch",
    };
  }
  const resolvedDefaultBranch = defaultBranch;

  let snapshotCommitSha = input.pending?.snapshotCommitSha;
  let markerCommitSha = input.pending?.markerCommitSha;

  // Reconcile remote HEAD before creating or pushing anything new.
  const remoteHead = await input.provider.getGitRef(owner, repo, resolvedDefaultBranch);
  const remoteHeadSha = remoteHead.object.sha;

  if (markerCommitSha && remoteHeadSha === markerCommitSha) {
    // Already complete remotely — continue to description finalization.
  } else if (snapshotCommitSha && remoteHeadSha === snapshotCommitSha && !markerCommitSha) {
    // Snapshot present; marker still needed.
  } else if (
    snapshotCommitSha &&
    markerCommitSha &&
    remoteHeadSha !== markerCommitSha &&
    remoteHeadSha !== snapshotCommitSha
  ) {
    return {
      ok: false,
      message: `Remote branch changed unexpectedly (expected marker ${markerCommitSha} or snapshot ${snapshotCommitSha}, found ${remoteHeadSha}). Force push is not allowed.`,
      recoverable: true,
      code: "ref-update-unexpected-head",
    };
  } else if (
    !snapshotCommitSha &&
    remoteHeadSha !== initializedCommitSha &&
    remoteHeadSha !== input.pending?.snapshotCommitSha
  ) {
    // Remote may already contain our commits from a prior interrupted push.
    try {
      const headCommit = await input.provider.getGitCommit(owner, repo, remoteHeadSha);
      if (headCommit.parents[0]?.sha === initializedCommitSha) {
        // Likely snapshot-only remote — treat as snapshot checkpoint.
        snapshotCommitSha = remoteHeadSha;
        await input.onCheckpoint?.({
          phase: "snapshot-commit-created",
          repositoryId,
          defaultBranch: resolvedDefaultBranch,
          initializedCommitSha,
          snapshotCommitSha,
          snapshotGitTreeSha1: input.manifest.gitRootTreeSha1,
        });
      } else if (headCommit.parents[0]?.sha) {
        const parent = await input.provider.getGitCommit(
          owner,
          repo,
          headCommit.parents[0].sha,
        );
        if (parent.parents[0]?.sha === initializedCommitSha) {
          snapshotCommitSha = headCommit.parents[0].sha;
          markerCommitSha = remoteHeadSha;
          await input.onCheckpoint?.({
            phase: "marker-pending",
            repositoryId,
            defaultBranch: resolvedDefaultBranch,
            initializedCommitSha,
            snapshotCommitSha,
            markerCommitSha,
            snapshotGitTreeSha1: input.manifest.gitRootTreeSha1,
          });
        } else if (remoteHeadSha !== initializedCommitSha) {
          return {
            ok: false,
            message: `Remote branch changed unexpectedly (expected initialized commit ${initializedCommitSha}, found ${remoteHeadSha}). Force push is not allowed.`,
            recoverable: true,
            code: "ref-update-unexpected-head",
          };
        }
      } else if (remoteHeadSha !== initializedCommitSha) {
        return {
          ok: false,
          message: `Remote branch changed unexpectedly (expected initialized commit ${initializedCommitSha}, found ${remoteHeadSha}). Force push is not allowed.`,
          recoverable: true,
          code: "ref-update-unexpected-head",
        };
      }
    } catch {
      if (remoteHeadSha !== initializedCommitSha) {
        return {
          ok: false,
          message: `Remote branch changed unexpectedly (expected initialized commit ${initializedCommitSha}, found ${remoteHeadSha}). Force push is not allowed.`,
          recoverable: true,
          code: "ref-update-unexpected-head",
        };
      }
    }
  }

  const usesBulkPush = typeof input.provider.pushHarnessSnapshotCommits === "function";

  if (usesBulkPush && (!snapshotCommitSha || !markerCommitSha)) {
    const expectedHeadSha = snapshotCommitSha ?? initializedCommitSha!;
    const lastSafeCheckpoint = snapshotCommitSha
      ? "snapshot-commit-created"
      : "repository-created";

    input.onProgress?.({
      phase: "preparing-snapshot",
      uploadedBlobs: 0,
      totalBlobs: input.manifest.fileCount,
      completed: 0,
      total: input.manifest.fileCount,
      lastSafeCheckpoint,
    });
    await input.onCheckpoint?.({
      phase: "preparing-snapshot",
      repositoryId,
      defaultBranch: resolvedDefaultBranch,
      initializedCommitSha,
      snapshotCommitSha,
      markerCommitSha,
      snapshotGitTreeSha1: input.manifest.gitRootTreeSha1,
    });

    try {
      const pushTimeoutMs = resolveGitPushTimeoutMs();
      const workspaceUploadStartedAt = performance.now();
      const pushResult = await withPhaseTimeout(
        "workspace-uploading",
        pushTimeoutMs,
        () =>
          input.provider.pushHarnessSnapshotCommits!({
            owner,
            repo,
            defaultBranch: resolvedDefaultBranch,
            expectedHeadSha,
            initializedCommitSha: initializedCommitSha!,
            snapshotRoot: input.snapshotRoot,
            manifest: input.manifest,
            operationId: input.operationId,
            packageVersion: input.packageVersion,
            existingSnapshotCommitSha: snapshotCommitSha,
            timeoutMs: pushTimeoutMs,
            buildMarkerContent: (resolvedSnapshotCommitSha) => {
              const marker = buildHarnessSnapshotManagedRepoMarker({
                repository: `${owner}/${input.repoName}`,
                repositoryId: repositoryId!,
                manifest: input.manifest,
                snapshotCommitSha: resolvedSnapshotCommitSha,
                operationId: input.operationId,
                createdByGithubUserId: input.user.id,
                createdByLogin: input.user.login,
                pDevVersion: input.packageVersion,
                defaultBranch: resolvedDefaultBranch,
              });
              return `${JSON.stringify(marker, null, 2)}\n`;
            },
            onProgress: (progress) => {
              input.onProgress?.({
                phase: progress.phase,
                uploadedBlobs: progress.completed ?? 0,
                totalBlobs: progress.total ?? input.manifest.fileCount,
                completed: progress.completed,
                total: progress.total ?? input.manifest.fileCount,
                lastSafeCheckpoint,
              });
            },
          }),
      );
      timings.workspaceUploadMs = elapsedProvisioningMs(workspaceUploadStartedAt);
      timings.gitTransport = pushResult.timings;

      snapshotCommitSha = pushResult.snapshotCommitSha;
      markerCommitSha = pushResult.markerCommitSha;

      await input.onCheckpoint?.({
        phase: "snapshot-commit-created",
        repositoryId,
        defaultBranch: resolvedDefaultBranch,
        initializedCommitSha,
        snapshotCommitSha,
        snapshotGitTreeSha1: input.manifest.gitRootTreeSha1,
      });
      await input.onCheckpoint?.({
        phase: "marker-pending",
        repositoryId,
        defaultBranch: resolvedDefaultBranch,
        initializedCommitSha,
        snapshotCommitSha,
        markerCommitSha,
        snapshotGitTreeSha1: input.manifest.gitRootTreeSha1,
      });
      input.onProgress?.({
        phase: "verifying",
        uploadedBlobs: input.manifest.fileCount,
        totalBlobs: input.manifest.fileCount,
        completed: input.manifest.fileCount,
        total: input.manifest.fileCount,
        lastSafeCheckpoint: "marker-pending",
      });
    } catch (error) {
      if (
        error instanceof SnapshotProvisioningError &&
        (error.code === "marker-commit-failed" ||
          error.code === "workspace-upload-failed" ||
          error.code === "workspace-upload-timeout" ||
          error.code === "remote-phase-timeout" ||
          error.code === "ref-update-unexpected-head" ||
          error.code === "snapshot-tree-mismatch")
      ) {
        return {
          ok: false,
          message: error.message,
          recoverable: error.recoverable,
          code: error.code,
        };
      }
      throw error;
    }
  } else if (!usesBulkPush) {
    // Legacy per-file REST path for providers without bulk git push (e.g. unit mocks).
    if (!snapshotCommitSha) {
      const blobShaByPath = await uploadSnapshotBlobs({
        provider: input.provider,
        owner,
        repo,
        snapshotRoot: input.snapshotRoot,
        manifest: input.manifest,
        retryContext,
        onProgress: input.onProgress,
      });
      snapshotCommitSha = await createSnapshotCommit({
        provider: input.provider,
        owner,
        repo,
        manifest: input.manifest,
        parentCommitSha: initializedCommitSha!,
        operationId: input.operationId,
        blobShaByPath,
        retryContext,
      });
      const currentRef = await input.provider.getGitRef(owner, repo, resolvedDefaultBranch);
      if (currentRef.object.sha !== snapshotCommitSha) {
        await withRetries(
          () =>
            input.provider.updateGitRef({
              owner,
              repo,
              ref: resolvedDefaultBranch,
              sha: snapshotCommitSha!,
              force: false,
              expectedSha: initializedCommitSha,
            }),
          retryContext,
          "snapshot-commit-created",
        );
      }
      await input.onCheckpoint?.({
        phase: "snapshot-commit-created",
        repositoryId,
        defaultBranch: resolvedDefaultBranch,
        initializedCommitSha,
        snapshotCommitSha,
        snapshotGitTreeSha1: input.manifest.gitRootTreeSha1,
      });
      input.onProgress?.({
        phase: "snapshot-commit-created",
        uploadedBlobs: input.manifest.fileCount,
        totalBlobs: input.manifest.fileCount,
      });
    }

    if (!markerCommitSha) {
      const marker = buildHarnessSnapshotManagedRepoMarker({
        repository: `${owner}/${input.repoName}`,
        repositoryId: repositoryId!,
        manifest: input.manifest,
        snapshotCommitSha: snapshotCommitSha!,
        operationId: input.operationId,
        createdByGithubUserId: input.user.id,
        createdByLogin: input.user.login,
        pDevVersion: input.packageVersion,
        defaultBranch: resolvedDefaultBranch,
      });
      try {
        markerCommitSha = await createMarkerCommit({
          provider: input.provider,
          owner,
          repo,
          defaultBranch: resolvedDefaultBranch,
          parentCommitSha: snapshotCommitSha!,
          snapshotTreeSha: input.manifest.gitRootTreeSha1,
          markerContent: `${JSON.stringify(marker, null, 2)}\n`,
          operationId: input.operationId,
          sourceCommit: input.manifest.sourceCommit,
          retryContext,
        });
      } catch (error) {
        if (error instanceof SnapshotProvisioningError && error.code === "marker-commit-failed") {
          return {
            ok: false,
            message: error.message,
            recoverable: true,
            code: error.code,
          };
        }
        throw error;
      }
      await input.onCheckpoint?.({
        phase: "marker-pending",
        repositoryId,
        defaultBranch: resolvedDefaultBranch,
        initializedCommitSha,
        snapshotCommitSha,
        markerCommitSha,
        snapshotGitTreeSha1: input.manifest.gitRootTreeSha1,
      });
      input.onProgress?.({
        phase: "marker-pending",
        uploadedBlobs: input.manifest.fileCount,
        totalBlobs: input.manifest.fileCount,
      });
    }
  }

  try {
    const descriptionFinalizationStartedAt = performance.now();
    await finalizeProvisioningRepositoryDescription({
      provider: input.provider,
      owner,
      repo,
      operationId: input.operationId,
      normalDescription: input.description,
      markerCommitSha: markerCommitSha!,
      defaultBranch: resolvedDefaultBranch,
    });
    timings.descriptionFinalizationMs = elapsedProvisioningMs(
      descriptionFinalizationStartedAt,
    );
  } catch (error) {
    if (
      error instanceof SnapshotProvisioningError &&
      error.code === "description-finalization-failed"
    ) {
      await input.onCheckpoint?.({
        phase: "description-pending",
        repositoryId,
        defaultBranch: resolvedDefaultBranch,
        initializedCommitSha,
        snapshotCommitSha,
        markerCommitSha,
        snapshotGitTreeSha1: input.manifest.gitRootTreeSha1,
      });
      return {
        ok: false,
        message: error.message,
        recoverable: error.recoverable,
        code: error.code,
      };
    }
    throw error;
  }

  return {
    ok: true,
    fullName: `${owner}/${input.repoName}`,
    repositoryId: repositoryId!,
    defaultBranch: resolvedDefaultBranch,
    initializedCommitSha: initializedCommitSha!,
    snapshotCommitSha: snapshotCommitSha!,
    markerCommitSha: markerCommitSha!,
    timings,
  };
}

export async function verifyProvisionedHarnessWorkspace(input: {
  provider: GitHubHarnessProvisioningProvider;
  repoSlug: string;
  repositoryId: number;
  manifest: WorkspaceSnapshotManifest;
}): Promise<{ ok: true } | { ok: false; message: string }> {
  const { owner, repo } = parseRepoSlug(input.repoSlug);
  const metadata = await input.provider.getRepositoryMetadata(owner, repo);
  if (!metadata) {
    return { ok: false, message: `Harness workspace ${input.repoSlug} is not accessible.` };
  }
  if (metadata.repositoryId !== input.repositoryId) {
    return {
      ok: false,
      message: `Harness workspace repository ID mismatch for ${input.repoSlug}.`,
    };
  }
  if (!metadata.private || !metadata.permissions.admin) {
    return {
      ok: false,
      message: `Harness workspace ${input.repoSlug} must be private and admin-accessible.`,
    };
  }

  const headSha = await input.provider.getRepositoryDefaultBranchHead(
    owner,
    repo,
    metadata.defaultBranch,
  );
  const markerRaw = await input.provider.readRepositoryFileContent(
    owner,
    repo,
    HARNESS_MANAGED_REPO_MARKER_FILE,
    headSha,
  );
  if (!markerRaw) {
    return { ok: false, message: "Provisioned workspace is missing the managed marker at HEAD." };
  }
  const marker = parseHarnessManagedRepoMarkerJson(markerRaw);
  if (!marker.ok) {
    return { ok: false, message: marker.reason };
  }
  if (!marker.marker.createdFromPackageSnapshot) {
    return {
      ok: false,
      message: "Provisioned workspace marker is not snapshot-backed.",
    };
  }
  const provenance = marker.marker.createdFromPackageSnapshot;
  if (
    provenance.snapshotContentId !== input.manifest.snapshotContentId ||
    provenance.snapshotSha256 !== input.manifest.snapshotSha256 ||
    provenance.snapshotGitTreeSha1 !== input.manifest.gitRootTreeSha1 ||
    provenance.sourceCommit !== input.manifest.sourceCommit
  ) {
    return {
      ok: false,
      message: "Provisioned workspace marker provenance does not match embedded manifest.",
    };
  }

  const headCommit = await input.provider.getGitCommit(owner, repo, headSha);
  const parentSha = headCommit.parents[0]?.sha;
  if (!parentSha) {
    return { ok: false, message: "Marker commit is missing a parent snapshot commit." };
  }
  const parentCommit = await input.provider.getGitCommit(owner, repo, parentSha);
  if (parentCommit.tree.sha !== input.manifest.gitRootTreeSha1) {
    return {
      ok: false,
      message: "Snapshot commit tree does not match embedded manifest.",
    };
  }

  const readme = await input.provider.readRepositoryFileContent(
    owner,
    repo,
    "README.md",
    headSha,
  );
  if (!readme) {
    return {
      ok: false,
      message: "Provisioned workspace HEAD is missing README.md from the packaged snapshot.",
    };
  }

  return { ok: true };
}

export async function loadSnapshotFileContent(
  snapshotRoot: string,
  snapshotPath: string,
  expectedSha256: string,
): Promise<Buffer> {
  return loadWorkspaceSnapshotEntryContent({
    snapshotRoot,
    path: snapshotPath,
    expectedSha256: expectedSha256,
  });
}

export async function readSnapshotManifestFromPackage(
  snapshotRoot: string,
): Promise<WorkspaceSnapshotManifest> {
  const raw = await readFile(path.join(snapshotRoot, "manifest.json"), "utf8");
  const parsed = JSON.parse(raw) as WorkspaceSnapshotManifest;
  return parsed;
}
