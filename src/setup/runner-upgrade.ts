import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { WorkspaceSnapshotManifest } from "../p-dev/workspace-snapshot-types.js";
import {
  loadEmbeddedWorkspaceSnapshotIdentityForStatus,
} from "./harness-workspace-snapshot-loader.js";
import {
  HARNESS_MANAGED_REPO_MARKER_FILE,
  parseHarnessManagedRepoMarkerJson,
  validateManagedMarkerForReconnect,
  type HarnessManagedRepoMarker,
} from "./harness-managed-repo-marker.js";
import { formatHarnessDispatchRepo, resolveHarnessDispatchRepo } from "./harness-dispatch-repo.js";
import { syncHarnessConfigCloudPair } from "./sync-harness-config-cloud.js";
import { recordRunnerUpgradeEvidence } from "./runner-upgrade-evidence.js";
import {
  clearRunnerUpgradePendingState,
  readRunnerUpgradePendingState,
  withHarnessRunnerUpgradeMutex,
  writeRunnerUpgradePendingStateAtomic,
  type RunnerUpgradePendingState,
} from "./runner-upgrade-pending-state.js";
import {
  writeRunnerUpgradeProgressAtomic,
  type RunnerUpgradeProgressState,
} from "./runner-upgrade-progress.js";
import {
  extractFileHashesFromManifest,
  extractFileHashesFromMarker,
  type FileHashMap,
} from "./runner-upgrade-three-way.js";
import {
  buildProvisionalUpgradeCommitOnBranch,
  compareRunnerUpgradeSnapshots,
  findExistingUpgradePullRequest,
  loadRunnerUpgradePackagedSnapshot,
  type RunnerUpgradeTargetContext,
} from "./runner-upgrade-materialization.js";
import {
  CANARY_OPERATION_ID_INPUT,
  locateCanaryRunByOperationId,
} from "./runner-upgrade-canary-dispatch.js";
import {
  asRemoteSetupProviderForRunnerUpgrade,
  type RunnerUpgradeGitHubProvider,
} from "./runner-upgrade-provider.js";
import {
  lastVerifiedToSnapshotSummary,
  readRunnerUpgradeLastVerifiedIdentity,
  writeRunnerUpgradeLastVerifiedIdentity,
} from "./runner-upgrade-status-cache.js";
import {
  RUNNER_UPGRADE_CANARY_WORKFLOW_PATH,
  buildRunnerUpgradeBranchName,
  buildRunnerUpgradePrMarker,
  runnerUpgradeStatusLabel,
  type RunnerUpgradeAcceptResult,
  type RunnerUpgradeApplyResult,
  type RunnerUpgradeImpactSummary,
  type RunnerUpgradePhase,
  type RunnerUpgradePreviewResult,
  type RunnerUpgradeSnapshotSummary,
  type RunnerUpgradeStatus,
  type RunnerUpgradeStatusResult,
} from "./runner-upgrade-types.js";
import {
  RUNNER_UPGRADE_STATUS_OVERALL_DEADLINE_MS,
  RUNNER_UPGRADE_STATUS_PROVIDER_TIMEOUT_MS,
  RUNNER_UPGRADE_WORKER_PROVIDER_TIMEOUT_MS,
  RunnerUpgradeStatusStageTracker,
  RunnerUpgradeTimeoutError,
  beginRunnerUpgradeStatusRequest,
  endRunnerUpgradeStatusRequest,
  recordRunnerUpgradeStatusCallTimings,
  throwIfRunnerUpgradeAborted,
  withRunnerUpgradeStatusDeadline,
  withTimedRunnerUpgradeCall,
  type RunnerUpgradeCallTiming,
  type RunnerUpgradeStatusStage,
} from "./runner-upgrade-timeouts.js";
import {
  enqueueRunnerUpgradeOperation,
  isRunnerUpgradeOperationActive,
  reconcileAbandonedRunnerUpgrades,
} from "./runner-upgrade-worker.js";

export {
  getLastRunnerUpgradeStatusCallTimings,
  getLastRunnerUpgradeStatusStageTimings,
  getLastUnresolvedRunnerUpgradeStatusStage,
  isRunnerUpgradeProgressStale,
  abortInFlightRunnerUpgradeStatus,
  RUNNER_UPGRADE_NO_PROGRESS_STALE_MS,
  RUNNER_UPGRADE_STATUS_OVERALL_DEADLINE_MS,
  RUNNER_UPGRADE_STATUS_PROVIDER_TIMEOUT_MS,
  RUNNER_UPGRADE_WORKER_PROVIDER_TIMEOUT_MS,
  runnerUpgradeProgressShowsNoProgress,
} from "./runner-upgrade-timeouts.js";

const ALL_RUNNER_UPGRADE_PHASES: RunnerUpgradePhase[] = [
  "verifying-managed-repository",
  "comparing-runner-snapshots",
  "preparing-upgrade-commit",
  "updating-managed-runner",
  "verifying-runner-on-production-branch",
  "synchronizing-cloud-configuration",
  "running-configuration-canary",
];

const DEFAULT_CANARY_POLL_INTERVAL_MS = 2_000;
const DEFAULT_CANARY_POLL_TIMEOUT_MS = 120_000;

type ResolveContextMode = "status" | "worker";

export interface RunnerUpgradeApplyOptions {
  previewFingerprint?: string;
  canaryPollIntervalMs?: number;
  canaryPollTimeoutMs?: number;
  /** When true, skip worker enqueue (used by the worker itself / sync unit tests). */
  executeInline?: boolean;
}

export interface RunnerUpgradeAcceptOptions {
  previewFingerprint?: string;
  resume?: boolean;
}

interface ResolvedRunnerUpgradeContext extends RunnerUpgradeTargetContext {}

function sha256Content(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function snapshotSummaryFromManifest(
  manifest: WorkspaceSnapshotManifest,
): RunnerUpgradeSnapshotSummary {
  return {
    snapshotContentId: manifest.snapshotContentId,
    packageVersion: manifest.packageVersion,
    sourceCommit: manifest.sourceCommit,
  };
}

function buildImpactSummary(input: {
  replacePaths: string[];
  deletePaths: string[];
}): RunnerUpgradeImpactSummary {
  return {
    replacePathCount: input.replacePaths.length,
    deletePathCount: input.deletePaths.length,
    sampleReplacePaths: input.replacePaths.slice(0, 8),
    sampleDeletePaths: input.deletePaths.slice(0, 8),
  };
}

function computePreviewFingerprint(input: {
  targetSnapshotContentId: string;
  replacePaths: string[];
  deletePaths: string[];
  repositoryId: number;
}): string {
  return sha256Content(
    JSON.stringify({
      targetSnapshotContentId: input.targetSnapshotContentId,
      replacePaths: [...input.replacePaths].sort(),
      deletePaths: [...input.deletePaths].sort(),
      repositoryId: input.repositoryId,
    }),
  );
}

async function resolveHarnessRepository(cwd?: string): Promise<{
  repoSlug: string;
  owner: string;
  repo: string;
}> {
  const harnessDispatchRepo = await resolveHarnessDispatchRepo({ cwd });
  if (!harnessDispatchRepo.resolved || !harnessDispatchRepo.repo) {
    throw new Error("Harness dispatch repository is not configured.");
  }
  const repoSlug = formatHarnessDispatchRepo(harnessDispatchRepo);
  const [owner, repo] = repoSlug.split("/");
  if (!owner || !repo) {
    throw new Error(`Invalid harness repository slug ${repoSlug}.`);
  }
  return { repoSlug, owner, repo };
}

async function loadPackagedSnapshot(): Promise<
  ResolvedRunnerUpgradeContext["packagedSnapshot"] | null
> {
  return loadRunnerUpgradePackagedSnapshot(import.meta.url);
}

async function loadPackagedSnapshotIdentityForStatus(
  signal?: AbortSignal,
): Promise<ResolvedRunnerUpgradeContext["packagedSnapshot"] | null> {
  const embedded = await loadEmbeddedWorkspaceSnapshotIdentityForStatus(
    import.meta.url,
    process.env,
    signal,
  );
  if (!embedded.ok) {
    return null;
  }
  return {
    packageRoot: embedded.packageRoot,
    snapshotRoot: embedded.snapshotRoot,
    packageVersion: embedded.packageVersion,
    manifest: embedded.manifest,
    fingerprint: embedded.fingerprint,
  };
}

async function hasLocalManagedRepoEvidence(cwd?: string): Promise<boolean> {
  const raw = await readLocalManagedRepoMarker(cwd);
  if (!raw) {
    return false;
  }
  const parsed = parseHarnessManagedRepoMarkerJson(raw);
  return parsed.ok;
}

async function readRemoteManagedMarker(
  provider: RunnerUpgradeGitHubProvider,
  input: {
    owner: string;
    repo: string;
    defaultBranch: string;
    defaultBranchHead: string;
    signal?: AbortSignal;
  },
): Promise<
  | { ok: true; marker: HarnessManagedRepoMarker }
  | { ok: false; status: RunnerUpgradeStatus; reason: string }
> {
  const raw = await provider.readRepositoryFileContent(
    input.owner,
    input.repo,
    HARNESS_MANAGED_REPO_MARKER_FILE,
    input.defaultBranchHead,
    { signal: input.signal },
  );
  if (!raw) {
    return {
      ok: false,
      status: "blocked_non_managed",
      reason: "Managed repository marker is missing on the default branch.",
    };
  }
  const parsed = parseHarnessManagedRepoMarkerJson(raw);
  if (!parsed.ok) {
    return {
      ok: false,
      status: "blocked_non_managed",
      reason: parsed.reason,
    };
  }
  if (!parsed.marker.createdFromPackageSnapshot) {
    return {
      ok: false,
      status: "blocked_non_managed",
      reason: "Managed repository was not created from a packaged workspace snapshot.",
    };
  }
  return { ok: true, marker: parsed.marker };
}

export interface ResolveRunnerUpgradeContextOptions {
  signal?: AbortSignal;
  tracker?: RunnerUpgradeStatusStageTracker;
  /** Test-only: never resolve after this stage begins. */
  testHangAfterStage?: RunnerUpgradeStatusStage;
  debugTimings?: boolean;
}

async function maybeHangForTest(
  stage: RunnerUpgradeStatusStage,
  options?: ResolveRunnerUpgradeContextOptions,
): Promise<void> {
  if (options?.testHangAfterStage !== stage) {
    return;
  }
  await new Promise<never>((_resolve, reject) => {
    const onAbort = () => {
      reject(
        new RunnerUpgradeTimeoutError(
          `test hang aborted at ${stage}`,
          "testHangAfterStage",
          0,
          stage,
        ),
      );
    };
    if (options.signal?.aborted) {
      onAbort();
      return;
    }
    options.signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function resolveRunnerUpgradeContext(
  cwd: string | undefined,
  provider: RunnerUpgradeGitHubProvider,
  mode: ResolveContextMode = "worker",
  options: ResolveRunnerUpgradeContextOptions = {},
): Promise<
  | { ok: true; context: ResolvedRunnerUpgradeContext }
  | { ok: false; result: RunnerUpgradeStatusResult }
> {
  const providerTimeoutMs =
    mode === "status"
      ? RUNNER_UPGRADE_STATUS_PROVIDER_TIMEOUT_MS
      : RUNNER_UPGRADE_WORKER_PROVIDER_TIMEOUT_MS;
  const timings: RunnerUpgradeCallTiming[] = [];
  const recordTiming = (timing: RunnerUpgradeCallTiming) => {
    timings.push(timing);
  };
  const tracker = options.tracker;
  const signal = options.signal;

  tracker?.begin("embedded_snapshot_identity");
  throwIfRunnerUpgradeAborted(signal);
  await maybeHangForTest("embedded_snapshot_identity", options);
  const packagedSnapshot =
    mode === "status"
      ? await loadPackagedSnapshotIdentityForStatus(signal)
      : await loadPackagedSnapshot();
  tracker?.end();
  if (!packagedSnapshot) {
    if (mode === "status") {
      recordRunnerUpgradeStatusCallTimings(timings);
    }
    return {
      ok: false,
      result: {
        status: "failed",
        statusLabel: runnerUpgradeStatusLabel("failed"),
        blockedReason: "Embedded workspace snapshot is unavailable.",
      },
    };
  }

  try {
    tracker?.begin("context_normalization");
    throwIfRunnerUpgradeAborted(signal);
    await maybeHangForTest("context_normalization", options);
    const { repoSlug, owner, repo } = await resolveHarnessRepository(cwd);
    tracker?.end();

    tracker?.begin("provider_wrapper");
    throwIfRunnerUpgradeAborted(signal);
    await maybeHangForTest("provider_wrapper", options);
    const metadata = await withTimedRunnerUpgradeCall(
      "getRepositoryMetadata",
      providerTimeoutMs,
      (callSignal) =>
        provider.getRepositoryMetadata(owner, repo, { signal: callSignal }),
      recordTiming,
      signal,
    );
    if (!metadata) {
      tracker?.end();
      if (mode === "status") {
        recordRunnerUpgradeStatusCallTimings(timings);
      }
      return {
        ok: false,
        result: {
          status: "failed",
          statusLabel: runnerUpgradeStatusLabel("failed"),
          blockedReason: `Harness repository ${repoSlug} is not accessible.`,
        },
      };
    }

    const defaultBranchHead = await withTimedRunnerUpgradeCall(
      "getRepositoryDefaultBranchHead",
      providerTimeoutMs,
      (callSignal) =>
        provider.getRepositoryDefaultBranchHead(
          owner,
          repo,
          metadata.defaultBranch,
          { signal: callSignal },
        ),
      recordTiming,
      signal,
    );
    tracker?.end();

    tracker?.begin("marker_parsing");
    throwIfRunnerUpgradeAborted(signal);
    await maybeHangForTest("marker_parsing", options);
    const markerResult = await withTimedRunnerUpgradeCall(
      "readRemoteManagedMarker",
      providerTimeoutMs,
      (callSignal) =>
        readRemoteManagedMarker(provider, {
          owner,
          repo,
          defaultBranch: metadata.defaultBranch,
          defaultBranchHead,
          signal: callSignal,
        }),
      recordTiming,
      signal,
    );
    tracker?.end();
    if (mode === "status") {
      recordRunnerUpgradeStatusCallTimings(timings);
    }
    if (!markerResult.ok) {
      return {
        ok: false,
        result: {
          status: markerResult.status,
          statusLabel: runnerUpgradeStatusLabel(markerResult.status),
          blockedReason: markerResult.reason,
          availableSnapshot: snapshotSummaryFromManifest(
            packagedSnapshot.manifest,
          ),
        },
      };
    }

    tracker?.begin("status_conversion");
    throwIfRunnerUpgradeAborted(signal);
    await maybeHangForTest("status_conversion", options);
    const reconnect = validateManagedMarkerForReconnect(
      markerResult.marker,
      repoSlug,
      { repositoryId: metadata.id },
    );
    if (!reconnect.ok) {
      tracker?.end();
      return {
        ok: false,
        result: {
          status: "blocked_non_managed",
          statusLabel: runnerUpgradeStatusLabel("blocked_non_managed"),
          blockedReason: reconnect.reason,
          currentSnapshot: markerResult.marker.createdFromPackageSnapshot
            ? {
                snapshotContentId:
                  markerResult.marker.createdFromPackageSnapshot
                    .snapshotContentId,
                packageVersion:
                  markerResult.marker.createdFromPackageSnapshot.packageVersion,
                sourceCommit:
                  markerResult.marker.createdFromPackageSnapshot.sourceCommit,
              }
            : undefined,
          availableSnapshot: snapshotSummaryFromManifest(
            packagedSnapshot.manifest,
          ),
        },
      };
    }
    tracker?.end();

    return {
      ok: true,
      context: {
        repoSlug,
        owner,
        repo,
        repositoryId: metadata.id,
        defaultBranch: metadata.defaultBranch,
        defaultBranchHead,
        marker: markerResult.marker,
        packagedSnapshot,
      },
    };
  } catch (error) {
    if (mode === "status") {
      recordRunnerUpgradeStatusCallTimings(timings);
      tracker?.markTimedOut();
    }
    if (error instanceof RunnerUpgradeTimeoutError || mode === "status") {
      return {
        ok: false,
        result: {
          status: "checking",
          statusLabel: runnerUpgradeStatusLabel("checking"),
          degraded: true,
          blockedReason:
            error instanceof Error
              ? error.message
              : "Runner upgrade status check timed out.",
          retryGuidance:
            "Retry status shortly. GitHub did not respond within the page-status deadline.",
          retryAvailable: true,
          unresolvedStage: tracker?.unresolvedStage,
          availableSnapshot: snapshotSummaryFromManifest(
            packagedSnapshot.manifest,
          ),
        },
      };
    }
    throw error;
  }
}

async function writeProgress(
  cwd: string | undefined,
  pending: RunnerUpgradePendingState,
  phase: RunnerUpgradePhase,
  extras?: Partial<
    Pick<
      RunnerUpgradeProgressState,
      | "lastSuccessfulProviderCallAt"
      | "workerHeartbeatAt"
      | "filesInspected"
      | "filesTotal"
      | "lastCompletedBatch"
      | "retryCount"
      | "retryable"
      | "errorCode"
      | "lastCheckpoint"
      | "recoveryInstruction"
    >
  >,
): Promise<void> {
  const now = new Date().toISOString();
  await writeRunnerUpgradeProgressAtomic(
    {
      operationId: pending.operationId,
      phase,
      phaseStartedAt: now,
      startedAt: pending.startedAt,
      canaryRunId: pending.canaryRunId,
      canaryRunUrl: pending.canaryRunUrl,
      prUrl: pending.prUrl,
      workerHeartbeatAt: extras?.workerHeartbeatAt ?? now,
      lastSuccessfulProviderCallAt: extras?.lastSuccessfulProviderCallAt,
      filesInspected: extras?.filesInspected,
      filesTotal: extras?.filesTotal,
      lastCompletedBatch: extras?.lastCompletedBatch,
      retryCount: extras?.retryCount,
      retryable: extras?.retryable,
      errorCode: extras?.errorCode,
      lastCheckpoint: extras?.lastCheckpoint ?? phase,
      recoveryInstruction: extras?.recoveryInstruction,
    },
    cwd,
  );
}

async function compareUpgradeSnapshots(
  provider: RunnerUpgradeGitHubProvider,
  context: ResolvedRunnerUpgradeContext,
  options?: {
    onHeartbeat?: (progress: {
      filesInspected: number;
      filesTotal: number;
      lastCompletedBatch: string;
    }) => Promise<void>;
  },
): Promise<
  | {
      ok: true;
      previousHashes: FileHashMap | null;
      remoteHashes: FileHashMap;
      nextHashes: FileHashMap;
      replacePaths: string[];
      deletePaths: string[];
      previewFingerprint: string;
    }
  | {
      ok: false;
      status: RunnerUpgradeStatus;
      conflictPaths?: string[];
      message: string;
    }
> {
  const previousHashes = extractFileHashesFromMarker(context.marker);
  const nextHashes = extractFileHashesFromManifest(context.packagedSnapshot.manifest);
  const compare = await compareRunnerUpgradeSnapshots(provider, context, options);
  if (!compare.ok) {
    return compare;
  }

  const previewFingerprint = computePreviewFingerprint({
    targetSnapshotContentId: context.packagedSnapshot.manifest.snapshotContentId,
    replacePaths: compare.replacePaths,
    deletePaths: compare.deletePaths,
    repositoryId: context.repositoryId,
  });

  return {
    ok: true,
    previousHashes,
    remoteHashes: {},
    nextHashes,
    replacePaths: compare.replacePaths,
    deletePaths: compare.deletePaths,
    previewFingerprint,
  };
}

async function verifyProductionMarker(
  provider: RunnerUpgradeGitHubProvider,
  context: ResolvedRunnerUpgradeContext,
  targetSnapshotContentId: string,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const headSha = await provider.getRepositoryDefaultBranchHead(
    context.owner,
    context.repo,
    context.defaultBranch,
  );
  const raw = await provider.readRepositoryFileContent(
    context.owner,
    context.repo,
    HARNESS_MANAGED_REPO_MARKER_FILE,
    headSha,
  );
  if (!raw) {
    return { ok: false, message: "Production marker is missing after merge." };
  }
  const parsed = parseHarnessManagedRepoMarkerJson(raw);
  if (!parsed.ok) {
    return { ok: false, message: parsed.reason };
  }
  const remoteSnapshotContentId =
    parsed.marker.createdFromPackageSnapshot?.snapshotContentId;
  if (remoteSnapshotContentId !== targetSnapshotContentId) {
    return {
      ok: false,
      message: `Production marker snapshotContentId mismatch (expected ${targetSnapshotContentId}, found ${remoteSnapshotContentId ?? "none"}).`,
    };
  }
  const remoteHashes = extractFileHashesFromMarker(parsed.marker);
  if (remoteHashes) {
    const nextHashes = extractFileHashesFromManifest(context.packagedSnapshot.manifest);
    for (const [filePath, expectedHash] of Object.entries(nextHashes)) {
      if (remoteHashes[filePath] !== expectedHash) {
        return {
          ok: false,
          message: `Production marker file hash mismatch for ${filePath}.`,
        };
      }
    }
  }
  return { ok: true };
}

async function pollCanaryRun(
  provider: RunnerUpgradeGitHubProvider,
  input: {
    owner: string;
    repo: string;
    runId: number;
    pollIntervalMs: number;
    pollTimeoutMs: number;
    onHeartbeat?: () => Promise<void>;
  },
): Promise<{ ok: true; run: { htmlUrl: string } } | { ok: false; message: string }> {
  const started = Date.now();
  while (Date.now() - started < input.pollTimeoutMs) {
    const run = await provider.getWorkflowRun(input.owner, input.repo, input.runId);
    await input.onHeartbeat?.();
    if (run.status === "completed") {
      if (run.conclusion === "success") {
        return { ok: true, run: { htmlUrl: run.htmlUrl } };
      }
      return {
        ok: false,
        message: `Configuration canary failed with conclusion ${run.conclusion ?? "unknown"}.`,
      };
    }
    await new Promise((resolve) => setTimeout(resolve, input.pollIntervalMs));
  }
  return { ok: false, message: "Configuration canary timed out." };
}

function statusFromPending(
  pending: RunnerUpgradePendingState,
): RunnerUpgradeStatusResult {
  if (pending.lastError) {
    const status: RunnerUpgradeStatus =
      pending.lastStatus ??
      (pending.codeUpdateComplete ? "partially_updated" : "failed");
    return {
      status,
      statusLabel: runnerUpgradeStatusLabel(status),
      pendingOperationId: pending.operationId,
      pendingPhase: pending.phase,
      blockedReason: pending.lastError,
      conflictPaths: pending.conflictPaths,
      prUrl: pending.prUrl,
      canaryRunUrl: pending.canaryRunUrl,
      retryGuidance: pending.codeUpdateComplete
        ? "Resume the runner upgrade to finish cloud sync or canary."
        : "Retry or Resume the runner upgrade after reviewing the error.",
      retryAvailable: true,
    };
  }
  return {
    status: pending.codeUpdateComplete ? "partially_updated" : "updating",
    statusLabel: runnerUpgradeStatusLabel(
      pending.codeUpdateComplete ? "partially_updated" : "updating",
    ),
    pendingOperationId: pending.operationId,
    pendingPhase: pending.phase,
    prUrl: pending.prUrl,
    canaryRunUrl: pending.canaryRunUrl,
  };
}

export interface LoadRunnerUpgradeStatusOptions {
  signal?: AbortSignal;
  debugTimings?: boolean;
  /** Test-only: never resolve after this stage begins. */
  testHangAfterStage?: RunnerUpgradeStatusStage;
  /** Override absolute deadline (tests). */
  overallDeadlineMs?: number;
  /** Workspace key for aborting prior in-flight status requests. */
  workspaceKey?: string;
}

async function withCachedIdentityFallback(
  cwd: string | undefined,
  result: RunnerUpgradeStatusResult,
  availableSnapshot?: RunnerUpgradeSnapshotSummary,
  debugTimings?: boolean,
  tracker?: RunnerUpgradeStatusStageTracker,
): Promise<RunnerUpgradeStatusResult> {
  const localManagedRepoEvidence = await hasLocalManagedRepoEvidence(cwd);
  const cached = await readRunnerUpgradeLastVerifiedIdentity(cwd);
  tracker?.commit();
  const base: RunnerUpgradeStatusResult = {
    ...result,
    localManagedRepoEvidence,
    availableSnapshot: result.availableSnapshot ?? availableSnapshot,
    unresolvedStage: result.unresolvedStage ?? tracker?.unresolvedStage,
    retryAvailable:
      result.retryAvailable ??
      (result.status === "checking" || result.degraded === true),
    debugTimings: debugTimings ? tracker?.snapshot() : result.debugTimings,
  };
  if (base.currentSnapshot || !cached) {
    return base;
  }
  return {
    ...base,
    currentSnapshot: lastVerifiedToSnapshotSummary(cached),
    currentSnapshotCached: true,
    currentSnapshotVerifiedAt: cached.verifiedAt,
  };
}

export async function loadRunnerUpgradeStatus(
  cwd: string | undefined,
  provider: RunnerUpgradeGitHubProvider,
  options: LoadRunnerUpgradeStatusOptions = {},
): Promise<RunnerUpgradeStatusResult> {
  const workspaceKey = options.workspaceKey ?? cwd ?? process.cwd();
  const { signal, controller } = options.signal
    ? { signal: options.signal, controller: null }
    : beginRunnerUpgradeStatusRequest(workspaceKey);
  const tracker = new RunnerUpgradeStatusStageTracker();
  const deadlineMs =
    options.overallDeadlineMs ?? RUNNER_UPGRADE_STATUS_OVERALL_DEADLINE_MS;

  const run = async (requestSignal: AbortSignal): Promise<RunnerUpgradeStatusResult> => {
    tracker.begin("local_state_reads");
    throwIfRunnerUpgradeAborted(requestSignal);
    const pending = await readRunnerUpgradePendingState(cwd);
    const localManagedRepoEvidence = await hasLocalManagedRepoEvidence(cwd);
    tracker.end();

    if (pending) {
      tracker.begin("reconciliation_enqueue");
      if (
        !pending.lastError &&
        !isRunnerUpgradeOperationActive(pending.operationId)
      ) {
        // Enqueue only — never await worker/mutex work on the status path.
        void reconcileAbandonedRunnerUpgrades(cwd);
      }
      tracker.end();
      tracker.begin("status_conversion");
      const fromPending = statusFromPending(pending);
      tracker.end();
      return withCachedIdentityFallback(
        cwd,
        {
          ...fromPending,
          localManagedRepoEvidence,
        },
        undefined,
        options.debugTimings,
        tracker,
      );
    }

    tracker.begin("embedded_snapshot_identity");
    throwIfRunnerUpgradeAborted(requestSignal);
    const packagedSnapshot =
      await loadPackagedSnapshotIdentityForStatus(requestSignal);
    tracker.end();
    const availableSnapshot = packagedSnapshot
      ? snapshotSummaryFromManifest(packagedSnapshot.manifest)
      : undefined;

    const checkingTimeout = (
      unresolvedStage?: RunnerUpgradeStatusStage,
      blockedReason?: string,
    ): Promise<RunnerUpgradeStatusResult> =>
      withCachedIdentityFallback(
        cwd,
        {
          status: "checking",
          statusLabel: runnerUpgradeStatusLabel("checking"),
          degraded: true,
          localManagedRepoEvidence,
          availableSnapshot,
          blockedReason:
            blockedReason ??
            `runner-upgrade-status overall deadline exceeded after ${deadlineMs}ms.`,
          retryGuidance:
            "Retry status shortly. GitHub did not respond within the page-status deadline.",
          retryAvailable: true,
          unresolvedStage,
        },
        availableSnapshot,
        options.debugTimings,
        tracker,
      );

    return withRunnerUpgradeStatusDeadline(
      deadlineMs,
      requestSignal,
      () => {
        if (!requestSignal.aborted) {
          controller?.abort();
        }
      },
      async (deadlineSignal) => {
        const resolved = await resolveRunnerUpgradeContext(
          cwd,
          provider,
          "status",
          {
            signal: deadlineSignal,
            tracker,
            testHangAfterStage: options.testHangAfterStage,
            debugTimings: options.debugTimings,
          },
        );
        if (!resolved.ok) {
          return withCachedIdentityFallback(
            cwd,
            {
              ...resolved.result,
              localManagedRepoEvidence,
              retryAvailable:
                resolved.result.status === "checking" ||
                resolved.result.degraded === true,
            },
            availableSnapshot,
            options.debugTimings,
            tracker,
          );
        }
        const { context } = resolved;
        tracker.begin("status_conversion");
        throwIfRunnerUpgradeAborted(deadlineSignal);
        const currentSnapshot = snapshotSummaryFromManifest(
          context.marker.createdFromPackageSnapshot
            ? {
                ...context.packagedSnapshot.manifest,
                snapshotContentId:
                  context.marker.createdFromPackageSnapshot.snapshotContentId,
                packageVersion:
                  context.marker.createdFromPackageSnapshot.packageVersion,
                sourceCommit:
                  context.marker.createdFromPackageSnapshot.sourceCommit,
              }
            : context.packagedSnapshot.manifest,
        );
        const verifiedAt = new Date().toISOString();
        await writeRunnerUpgradeLastVerifiedIdentity(
          {
            ...currentSnapshot,
            verifiedAt,
            repoSlug: context.repoSlug,
          },
          cwd,
        );
        tracker.end();

        if (
          currentSnapshot.snapshotContentId ===
          availableSnapshot?.snapshotContentId
        ) {
          return withCachedIdentityFallback(
            cwd,
            {
              status: "up_to_date",
              statusLabel: runnerUpgradeStatusLabel("up_to_date"),
              currentSnapshot,
              availableSnapshot,
              localManagedRepoEvidence,
              currentSnapshotVerifiedAt: verifiedAt,
            },
            availableSnapshot,
            options.debugTimings,
            tracker,
          );
        }

        return withCachedIdentityFallback(
          cwd,
          {
            status: "update_available",
            statusLabel: runnerUpgradeStatusLabel("update_available"),
            currentSnapshot,
            availableSnapshot,
            localManagedRepoEvidence,
            currentSnapshotVerifiedAt: verifiedAt,
          },
          availableSnapshot,
          options.debugTimings,
          tracker,
        );
      },
      (unresolvedStage) => checkingTimeout(unresolvedStage),
      tracker,
    );
  };

  try {
    return await run(signal);
  } finally {
    if (controller) {
      endRunnerUpgradeStatusRequest(workspaceKey, controller);
    }
  }
}

export async function previewRunnerUpgrade(
  cwd: string | undefined,
  provider: RunnerUpgradeGitHubProvider,
): Promise<RunnerUpgradePreviewResult> {
  const resolved = await resolveRunnerUpgradeContext(cwd, provider);
  if (!resolved.ok) {
    return {
      previewFingerprint: "",
      targetSnapshotContentId: "",
      phases: ALL_RUNNER_UPGRADE_PHASES,
      blocked: true,
      blockedStatus: resolved.result.status,
      message: resolved.result.blockedReason,
      impact: {
        replacePathCount: 0,
        deletePathCount: 0,
        sampleReplacePaths: [],
        sampleDeletePaths: [],
      },
    };
  }

  const compare = await compareUpgradeSnapshots(provider, resolved.context);
  if (!compare.ok) {
    return {
      previewFingerprint: "",
      targetSnapshotContentId:
        resolved.context.packagedSnapshot.manifest.snapshotContentId,
      currentSnapshotContentId:
        resolved.context.marker.createdFromPackageSnapshot?.snapshotContentId,
      phases: ALL_RUNNER_UPGRADE_PHASES,
      blocked: true,
      blockedStatus: compare.status,
      conflictPaths: compare.conflictPaths,
      message: compare.message,
      impact: {
        replacePathCount: 0,
        deletePathCount: 0,
        sampleReplacePaths: [],
        sampleDeletePaths: [],
      },
    };
  }

  return {
    previewFingerprint: compare.previewFingerprint,
    targetSnapshotContentId:
      resolved.context.packagedSnapshot.manifest.snapshotContentId,
    currentSnapshotContentId:
      resolved.context.marker.createdFromPackageSnapshot?.snapshotContentId,
    impact: buildImpactSummary({
      replacePaths: compare.replacePaths,
      deletePaths: compare.deletePaths,
    }),
    phases: ALL_RUNNER_UPGRADE_PHASES,
  };
}

async function buildAcceptedPendingState(
  cwd: string | undefined,
  options: RunnerUpgradeAcceptOptions = {},
): Promise<RunnerUpgradePendingState> {
  const existing = await readRunnerUpgradePendingState(cwd);
  if (existing) {
    const next: RunnerUpgradePendingState = {
      ...existing,
      previewFingerprint:
        options.previewFingerprint ?? existing.previewFingerprint,
    };
    if (options.resume || existing.lastError) {
      delete next.lastError;
      delete next.lastStatus;
    }
    return next;
  }

  const packagedSnapshot = await loadPackagedSnapshot();
  if (!packagedSnapshot) {
    throw new Error("Embedded workspace snapshot is unavailable.");
  }
  const { repoSlug } = await resolveHarnessRepository(cwd);
  let repositoryId = 0;
  let defaultBranch = "main";
  try {
    const localMarkerRaw = await readLocalManagedRepoMarker(cwd);
    if (localMarkerRaw) {
      const parsed = parseHarnessManagedRepoMarkerJson(localMarkerRaw);
      if (parsed.ok) {
        repositoryId = parsed.marker.repositoryId ?? repositoryId;
        defaultBranch =
          parsed.marker.createdFromTemplate?.defaultBranch ?? defaultBranch;
      }
    }
  } catch {
    // Local marker is optional for accept.
  }

  return {
    operationId: randomUUID(),
    repositoryId,
    repoSlug,
    defaultBranch,
    targetSnapshotContentId: packagedSnapshot.manifest.snapshotContentId,
    phase: "verifying-managed-repository",
    startedAt: new Date().toISOString(),
    previewFingerprint: options.previewFingerprint ?? "",
    syncInProgress: false,
    codeUpdateComplete: false,
    branchName: buildRunnerUpgradeBranchName(
      packagedSnapshot.manifest.snapshotContentId,
    ),
  };
}

/**
 * Accept an upgrade: write durable pending/progress locally, enqueue the
 * process-level worker, and return before any remote provider work.
 */
export async function acceptRunnerUpgrade(
  cwd: string | undefined,
  options: RunnerUpgradeAcceptOptions = {},
): Promise<{
  apply: RunnerUpgradeAcceptResult;
  progress: RunnerUpgradeProgressState;
}> {
  const workspaceDir = cwd ?? process.cwd();
  return withHarnessRunnerUpgradeMutex(workspaceDir, async () => {
    const pending = await buildAcceptedPendingState(cwd, options);
    await writeRunnerUpgradePendingStateAtomic(pending, cwd);
    const progress = await writeRunnerUpgradeProgressAtomic(
      {
        operationId: pending.operationId,
        phase: pending.phase,
        phaseStartedAt: new Date().toISOString(),
        startedAt: pending.startedAt,
        canaryRunId: pending.canaryRunId,
        canaryRunUrl: pending.canaryRunUrl,
        prUrl: pending.prUrl,
        workerHeartbeatAt: new Date().toISOString(),
        lastCheckpoint: pending.phase,
      },
      cwd,
    );
    enqueueRunnerUpgradeOperation(pending.operationId, cwd);
    return {
      apply: {
        operationId: pending.operationId,
        status: "updating",
        phase: pending.phase,
        previewFingerprint: pending.previewFingerprint,
        message: "Runner upgrade accepted and queued.",
      },
      progress,
    };
  });
}

/**
 * Execute a previously accepted upgrade from durable pending state.
 * Owned by the process-level worker (or sync unit tests via executeInline).
 */
export async function executeRunnerUpgradeOperation(
  cwd: string | undefined,
  provider: RunnerUpgradeGitHubProvider,
  options: RunnerUpgradeApplyOptions = {},
): Promise<RunnerUpgradeApplyResult> {
  return applyRunnerUpgradeInternal(cwd, provider, options);
}

async function applyRunnerUpgradeInternal(
  cwd: string | undefined,
  provider: RunnerUpgradeGitHubProvider,
  options: RunnerUpgradeApplyOptions = {},
): Promise<RunnerUpgradeApplyResult> {
  let pending = await readRunnerUpgradePendingState(cwd);
  const startedAt = pending?.startedAt ?? new Date().toISOString();
  const operationId = pending?.operationId ?? randomUUID();

  if (!pending) {
    pending = await buildAcceptedPendingState(cwd, {
      previewFingerprint: options.previewFingerprint,
    });
    await writeRunnerUpgradePendingStateAtomic(pending, cwd);
    await writeProgress(cwd, pending, pending.phase, {
      workerHeartbeatAt: new Date().toISOString(),
      lastSuccessfulProviderCallAt: undefined,
    });
  } else {
    await writeProgress(cwd, pending, pending.phase, {
      workerHeartbeatAt: new Date().toISOString(),
    });
  }

  const resolved = await resolveRunnerUpgradeContext(cwd, provider, "worker");
  if (!resolved.ok) {
    pending.lastError = resolved.result.blockedReason;
    pending.lastStatus = resolved.result.status;
    pending.phase = "verifying-managed-repository";
    await writeRunnerUpgradePendingStateAtomic(pending, cwd);
    await writeProgress(cwd, pending, pending.phase, {
      retryable: true,
      errorCode: "verify_managed_repository_failed",
    });
    return {
      operationId,
      status: resolved.result.status,
      phase: "verifying-managed-repository",
      previewFingerprint: pending.previewFingerprint,
      message: resolved.result.blockedReason,
    };
  }
  const context = resolved.context;
  if (context.marker.createdFromPackageSnapshot) {
    await writeRunnerUpgradeLastVerifiedIdentity(
      {
        snapshotContentId:
          context.marker.createdFromPackageSnapshot.snapshotContentId,
        packageVersion:
          context.marker.createdFromPackageSnapshot.packageVersion,
        sourceCommit: context.marker.createdFromPackageSnapshot.sourceCommit,
        verifiedAt: new Date().toISOString(),
        repoSlug: context.repoSlug,
      },
      cwd,
    );
  }
  pending.repositoryId = context.repositoryId;
  pending.repoSlug = context.repoSlug;
  pending.defaultBranch = context.defaultBranch;
  pending.targetSnapshotContentId =
    context.packagedSnapshot.manifest.snapshotContentId;
  await writeRunnerUpgradePendingStateAtomic(pending, cwd);
  await writeProgress(cwd, pending, pending.phase, {
    lastSuccessfulProviderCallAt: new Date().toISOString(),
    workerHeartbeatAt: new Date().toISOString(),
  });

  if (
    context.marker.createdFromPackageSnapshot?.snapshotContentId ===
      context.packagedSnapshot.manifest.snapshotContentId &&
    !pending.codeUpdateComplete
  ) {
    await clearRunnerUpgradePendingState(cwd);
    return {
      operationId,
      status: "up_to_date",
      phase: "verifying-managed-repository",
      previewFingerprint: pending.previewFingerprint,
      message: "Runner is already up to date.",
    };
  }

  let compare:
    | Awaited<ReturnType<typeof compareUpgradeSnapshots>>
    | null = null;
  if (!pending.codeUpdateComplete) {
    pending.phase = "comparing-runner-snapshots";
    await writeRunnerUpgradePendingStateAtomic(pending, cwd);
    await writeProgress(cwd, pending, pending.phase, {
      workerHeartbeatAt: new Date().toISOString(),
    });

    compare = await compareUpgradeSnapshots(provider, context, {
      onHeartbeat: async (heartbeat) => {
        await writeProgress(cwd, pending!, pending!.phase, {
          workerHeartbeatAt: new Date().toISOString(),
          lastSuccessfulProviderCallAt: new Date().toISOString(),
          filesInspected: heartbeat.filesInspected,
          filesTotal: heartbeat.filesTotal,
          lastCompletedBatch: heartbeat.lastCompletedBatch,
          lastCheckpoint: "comparing-runner-snapshots",
        });
      },
    });
    if (!compare.ok) {
      pending.phase = "comparing-runner-snapshots";
      pending.conflictPaths = compare.conflictPaths;
      pending.lastError = compare.message;
      pending.syncInProgress = false;
      await writeRunnerUpgradePendingStateAtomic(pending, cwd);
      await writeProgress(cwd, pending, pending.phase, {
        retryable: true,
        errorCode: compare.status,
      });
      return {
        operationId,
        status: compare.status,
        phase: "comparing-runner-snapshots",
        previewFingerprint: pending.previewFingerprint,
        message: compare.message,
      };
    }
    if (
      options.previewFingerprint &&
      options.previewFingerprint !== compare.previewFingerprint
    ) {
      pending.lastError =
        "Preview fingerprint mismatch; re-run preview before applying.";
      await writeRunnerUpgradePendingStateAtomic(pending, cwd);
      await writeProgress(cwd, pending, pending.phase, {
        retryable: true,
        errorCode: "preview_fingerprint_mismatch",
      });
      return {
        operationId,
        status: "failed",
        phase: "comparing-runner-snapshots",
        previewFingerprint: compare.previewFingerprint,
        message: pending.lastError,
      };
    }
  }

  const previewFingerprint =
    pending.previewFingerprint || compare?.previewFingerprint || "";
  pending.previewFingerprint = previewFingerprint;
  const branchName =
    pending.branchName ??
    buildRunnerUpgradeBranchName(
      context.packagedSnapshot.manifest.snapshotContentId,
    );
  pending.branchName = branchName;
  const targetSnapshotContentId =
    context.packagedSnapshot.manifest.snapshotContentId;

  await writeRunnerUpgradePendingStateAtomic(pending, cwd);
  await writeProgress(cwd, pending, pending.phase, {
    lastSuccessfulProviderCallAt: new Date().toISOString(),
    workerHeartbeatAt: new Date().toISOString(),
  });

  if (!pending.codeUpdateComplete) {
    pending.phase = "preparing-upgrade-commit";
    await writeRunnerUpgradePendingStateAtomic(pending, cwd);
    await writeProgress(cwd, pending, pending.phase, {
      workerHeartbeatAt: new Date().toISOString(),
    });

    const upgradeCommit = await buildProvisionalUpgradeCommitOnBranch(provider, context, {
      operationId,
      branchName,
      replacePaths: compare!.replacePaths,
      deletePaths: compare!.deletePaths,
    });
    await writeProgress(cwd, pending, pending.phase, {
      lastSuccessfulProviderCallAt: new Date().toISOString(),
      workerHeartbeatAt: new Date().toISOString(),
    });

    pending.phase = "updating-managed-runner";
    await writeRunnerUpgradePendingStateAtomic(pending, cwd);
    await writeProgress(cwd, pending, pending.phase);

    let pr = await findExistingUpgradePullRequest(provider, {
      owner: context.owner,
      repo: context.repo,
      repositoryId: context.repositoryId,
      snapshotContentId: targetSnapshotContentId,
      defaultBranch: context.defaultBranch,
      branchName,
    });

    if (!pr) {
      const created = await provider.createPullRequest({
        owner: context.owner,
        repo: context.repo,
        title: `Update p-dev runner to ${context.packagedSnapshot.packageVersion}`,
        head: branchName,
        base: context.defaultBranch,
        body: [
          buildRunnerUpgradePrMarker(context.repositoryId, targetSnapshotContentId),
          "",
          `Updates the managed p-dev runner workspace to package ${context.packagedSnapshot.packageVersion}.`,
        ].join("\n"),
      });
      pr = {
        number: created.number,
        htmlUrl: created.htmlUrl,
        headSha: upgradeCommit.headSha,
      };
    }

    pending.prUrl = pr.htmlUrl;
    pending.prNumber = pr.number;
    await writeRunnerUpgradePendingStateAtomic(pending, cwd);
    await writeProgress(cwd, pending, pending.phase);

    const latestHeadRef = await provider.getGitRef(
      context.owner,
      context.repo,
      branchName,
    );
    const mergeHeadSha = latestHeadRef.object.sha;

    await provider.mergePullRequest(context.owner, context.repo, pr.number, {
      mergeMethod: "squash",
      commitTitle: `Update p-dev runner to ${context.packagedSnapshot.packageVersion}`,
      expectedHeadSha: mergeHeadSha,
    });

    pending.phase = "verifying-runner-on-production-branch";
    await writeRunnerUpgradePendingStateAtomic(pending, cwd);
    await writeProgress(cwd, pending, pending.phase);

    const productionCheck = await verifyProductionMarker(
      provider,
      context,
      targetSnapshotContentId,
    );
    if (!productionCheck.ok) {
      pending.lastError = productionCheck.message;
      pending.phase = "verifying-runner-on-production-branch";
      await writeRunnerUpgradePendingStateAtomic(pending, cwd);
      await writeProgress(cwd, pending, pending.phase);
      return {
        operationId,
        status: "failed",
        phase: pending.phase,
        previewFingerprint,
        prUrl: pending.prUrl,
        prNumber: pending.prNumber,
        branchName,
        message: productionCheck.message,
      };
    }

    pending.codeUpdateComplete = true;
    pending.phase = "synchronizing-cloud-configuration";
    await writeRunnerUpgradePendingStateAtomic(pending, cwd);
    await writeProgress(cwd, pending, pending.phase);
  }

  pending.syncInProgress = true;
  pending.phase = "synchronizing-cloud-configuration";
  await writeRunnerUpgradePendingStateAtomic(pending, cwd);
  await writeProgress(cwd, pending, pending.phase);

  try {
    const syncResult = await syncHarnessConfigCloudPair({
      cwd,
      provider: asRemoteSetupProviderForRunnerUpgrade(provider),
      harnessRepository: context.repoSlug,
    });
    pending.expectedFingerprint = syncResult.fingerprint;
  } catch (error) {
    pending.lastError =
      error instanceof Error ? error.message : "Cloud configuration sync failed.";
    pending.syncInProgress = false;
    pending.phase = "synchronizing-cloud-configuration";
    await writeRunnerUpgradePendingStateAtomic(pending, cwd);
    await writeProgress(cwd, pending, pending.phase);
    return {
      operationId,
      status: "partially_updated",
      phase: pending.phase,
      previewFingerprint,
      prUrl: pending.prUrl,
      prNumber: pending.prNumber,
      branchName,
      message: pending.lastError,
    };
  }

  pending.phase = "running-configuration-canary";
  await writeRunnerUpgradePendingStateAtomic(pending, cwd);
  await writeProgress(cwd, pending, pending.phase);

  const canaryOperationId = randomUUID();
  // GitHub workflow_dispatch returns 204 with no run id — locate by operation id.
  await provider.dispatchWorkflow(
    context.owner,
    context.repo,
    RUNNER_UPGRADE_CANARY_WORKFLOW_PATH,
    context.defaultBranch,
    { [CANARY_OPERATION_ID_INPUT]: canaryOperationId },
  );
  const located = await locateCanaryRunByOperationId(provider, {
    owner: context.owner,
    repo: context.repo,
    operationId: canaryOperationId,
    ref: context.defaultBranch,
    pollIntervalMs: options.canaryPollIntervalMs ?? DEFAULT_CANARY_POLL_INTERVAL_MS,
    pollTimeoutMs: Math.min(
      options.canaryPollTimeoutMs ?? DEFAULT_CANARY_POLL_TIMEOUT_MS,
      60_000,
    ),
  });
  if (!located) {
    pending.lastError = `Could not locate canary workflow run for operation id ${canaryOperationId} after workflow_dispatch (204).`;
    pending.syncInProgress = false;
    await writeRunnerUpgradePendingStateAtomic(pending, cwd);
    await writeProgress(cwd, pending, pending.phase);
    return {
      operationId,
      status: "partially_updated",
      phase: pending.phase,
      previewFingerprint,
      prUrl: pending.prUrl,
      prNumber: pending.prNumber,
      branchName,
      message: pending.lastError,
    };
  }

  pending.canaryRunId = String(located.id);
  const canaryPoll = await pollCanaryRun(provider, {
    owner: context.owner,
    repo: context.repo,
    runId: located.id,
    pollIntervalMs: options.canaryPollIntervalMs ?? DEFAULT_CANARY_POLL_INTERVAL_MS,
    pollTimeoutMs: options.canaryPollTimeoutMs ?? DEFAULT_CANARY_POLL_TIMEOUT_MS,
    onHeartbeat: async () => {
      await writeProgress(cwd, pending, pending.phase, {
        lastSuccessfulProviderCallAt: new Date().toISOString(),
        workerHeartbeatAt: new Date().toISOString(),
        lastCheckpoint: "running-configuration-canary",
      });
    },
  });

  if (!canaryPoll.ok) {
    pending.canaryRunUrl =
      located.htmlUrl ??
      `https://github.com/${context.owner}/${context.repo}/actions/runs/${located.id}`;
    pending.lastError = canaryPoll.message;
    pending.syncInProgress = false;
    await writeRunnerUpgradePendingStateAtomic(pending, cwd);
    await writeProgress(cwd, pending, pending.phase);
    return {
      operationId,
      status: "partially_updated",
      phase: pending.phase,
      previewFingerprint,
      prUrl: pending.prUrl,
      prNumber: pending.prNumber,
      branchName,
      canaryRunId: pending.canaryRunId,
      canaryRunUrl: pending.canaryRunUrl,
      message: pending.lastError,
    };
  }

  pending.canaryRunUrl = canaryPoll.run.htmlUrl;
  await recordRunnerUpgradeEvidence(
    {
      appliedSnapshotContentId: targetSnapshotContentId,
      appliedAt: new Date().toISOString(),
      targetSnapshotContentId,
      repositoryId: context.repositoryId,
      lastOperationId: operationId,
      syncInProgress: false,
      status: "up_to_date",
      canaryRunUrl: pending.canaryRunUrl,
    },
    cwd,
  );
  await clearRunnerUpgradePendingState(cwd);
  await writeRunnerUpgradeProgressAtomic(
    {
      operationId,
      phase: "running-configuration-canary",
      phaseStartedAt: new Date().toISOString(),
      startedAt,
      canaryRunUrl: pending.canaryRunUrl,
      prUrl: pending.prUrl,
      recoveryInstruction: "Runner upgrade completed successfully.",
    },
    cwd,
  );

  return {
    operationId,
    status: "up_to_date",
    phase: "running-configuration-canary",
    previewFingerprint,
    prUrl: pending.prUrl,
    prNumber: pending.prNumber,
    branchName,
    canaryRunId: pending.canaryRunId,
    canaryRunUrl: pending.canaryRunUrl,
    message: "Runner upgrade completed successfully.",
  };
}

/**
 * Synchronous apply path for unit tests and inline execution.
 * Writes durable pending first, then runs the upgrade body under the mutex.
 * GUI/routes should use acceptRunnerUpgrade + the process worker instead.
 */
export async function applyRunnerUpgrade(
  cwd: string | undefined,
  provider: RunnerUpgradeGitHubProvider,
  options: RunnerUpgradeApplyOptions = {},
): Promise<RunnerUpgradeApplyResult> {
  const workspaceDir = cwd ?? process.cwd();
  return withHarnessRunnerUpgradeMutex(workspaceDir, () =>
    applyRunnerUpgradeInternal(cwd, provider, {
      ...options,
      executeInline: true,
    }),
  );
}

export async function resumeRunnerUpgrade(
  cwd: string | undefined,
  provider: RunnerUpgradeGitHubProvider,
  options: RunnerUpgradeApplyOptions = {},
): Promise<RunnerUpgradeApplyResult> {
  const pending = await readRunnerUpgradePendingState(cwd);
  if (!pending) {
    return {
      operationId: randomUUID(),
      status: "update_available",
      phase: "verifying-managed-repository",
      previewFingerprint: "",
      message: "No pending runner upgrade operation to resume.",
    };
  }
  delete pending.lastError;
  await writeRunnerUpgradePendingStateAtomic(pending, cwd);
  return applyRunnerUpgrade(cwd, provider, options);
}

export async function readLocalManagedRepoMarker(
  cwd?: string,
): Promise<string | null> {
  const markerPath =
    process.env.CANARY_MARKER_PATH ??
    path.join(cwd ?? process.cwd(), HARNESS_MANAGED_REPO_MARKER_FILE);
  try {
    return await readFile(markerPath, "utf8");
  } catch {
    return null;
  }
}
