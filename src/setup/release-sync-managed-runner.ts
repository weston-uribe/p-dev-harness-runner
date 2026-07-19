import { randomUUID } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { P_DEV_PACKAGE_ROOT_ENV } from "../p-dev/package-paths.js";
import { loadEmbeddedWorkspaceSnapshot } from "./harness-workspace-snapshot-loader.js";
import {
  HARNESS_MANAGED_REPO_MARKER_FILE,
  parseHarnessManagedRepoMarkerJson,
  validateManagedMarkerForReconnect,
} from "./harness-managed-repo-marker.js";
import {
  clearRunnerUpgradePendingState,
  readRunnerUpgradePendingState,
  type RunnerUpgradePendingState,
} from "./runner-upgrade-pending-state.js";
import {
  clearRunnerUpgradeProgress,
  readRunnerUpgradeProgress,
} from "./runner-upgrade-progress.js";
import { resolveLocalFilePaths } from "./setup-state.js";
import { syncHarnessConfigCloudPair } from "./sync-harness-config-cloud.js";
import {
  applyRunnerUpgrade,
  type RunnerUpgradeApplyOptions,
} from "./runner-upgrade.js";
import {
  CANARY_OPERATION_ID_INPUT,
  locateCanaryRunByOperationId,
} from "./runner-upgrade-canary-dispatch.js";
import {
  asRemoteSetupProviderForRunnerUpgrade,
  type RunnerUpgradeGitHubProvider,
} from "./runner-upgrade-provider.js";
import {
  RUNNER_UPGRADE_CANARY_WORKFLOW_PATH,
  type RunnerUpgradePhase,
} from "./runner-upgrade-types.js";

/** Release-unblocker target: the completed FRE test harness repository only. */
export const RELEASE_SYNC_EXPECTED_REPO_SLUG = "weston-uribe/p-dev-harness";
export const RELEASE_SYNC_EXPECTED_REPOSITORY_ID = 1_304_282_812;
export const RELEASE_SYNC_OVERALL_TIMEOUT_MS = 10 * 60 * 1000;
export const RELEASE_SYNC_CANARY_POLL_INTERVAL_MS = 2_000;
export const RELEASE_SYNC_CANARY_POLL_TIMEOUT_MS = 4 * 60 * 1000;

export type ReleaseSyncManagedRunnerPhase =
  | "cancel_pending"
  | "load_packaged_snapshot"
  | "resolve_repository"
  | "verify_managed_marker"
  | "verify_main_baseline"
  | "replace_runner_snapshot"
  | "sync_cloud_config"
  | "run_configuration_canary"
  | "complete";

export class ReleaseSyncManagedRunnerError extends Error {
  readonly code = "release_sync_managed_runner_failed";

  constructor(
    readonly phase: ReleaseSyncManagedRunnerPhase,
    message: string,
  ) {
    super(message);
    this.name = "ReleaseSyncManagedRunnerError";
  }
}

export interface ReleaseSyncCancelResult {
  cancelled: boolean;
  archivedDir?: string;
  pending?: RunnerUpgradePendingState | null;
  remoteMutationEvidence: {
    hadBranchName: boolean;
    hadPrUrl: boolean;
    hadCanaryRunUrl: boolean;
    codeUpdateComplete: boolean;
  };
}

export interface ReleaseSyncManagedRunnerResult {
  ok: boolean;
  phase: ReleaseSyncManagedRunnerPhase;
  repoSlug: string;
  repositoryId: number;
  packagedSnapshotContentId: string;
  remoteSnapshotContentId?: string;
  codeUpdateSkippedBecauseAlreadyCurrent: boolean;
  fingerprint?: string;
  prUrl?: string;
  prNumber?: number;
  branchName?: string;
  canaryRunId?: string;
  canaryRunUrl?: string;
  message: string;
  cancel?: ReleaseSyncCancelResult;
}

export interface ReleaseSyncManagedRunnerOptions {
  cwd: string;
  apply: boolean;
  /** Cancel/archive any local pending before sync (default true). */
  cancelPending?: boolean;
  overallTimeoutMs?: number;
  canaryPollIntervalMs?: number;
  canaryPollTimeoutMs?: number;
  expectedRepoSlug?: string;
  expectedRepositoryId?: number;
}

async function archiveAndClearPending(cwd: string): Promise<ReleaseSyncCancelResult> {
  const pending = await readRunnerUpgradePendingState(cwd);
  const progress = await readRunnerUpgradeProgress(cwd);
  if (!pending && !progress) {
    return {
      cancelled: false,
      pending: null,
      remoteMutationEvidence: {
        hadBranchName: false,
        hadPrUrl: false,
        hadCanaryRunUrl: false,
        codeUpdateComplete: false,
      },
    };
  }

  const paths = resolveLocalFilePaths(cwd);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const archivedDir = path.join(
    paths.harnessDir,
    "archive",
    `runner-upgrade-cancelled-${stamp}`,
  );
  try {
    await mkdir(archivedDir, { recursive: true });
  } catch (error) {
    const code =
      error && typeof error === "object" && "code" in error
        ? String((error as { code?: unknown }).code)
        : "";
    if (code === "EACCES" || code === "EPERM") {
      throw new ReleaseSyncManagedRunnerError(
        "cancel_pending",
        `Cannot archive pending runner-upgrade state under ${paths.harnessDir} (permission denied). Re-run as the workspace owner, e.g. pdevtest.`,
      );
    }
    throw error;
  }

  const pendingPath = path.join(paths.harnessDir, "p-dev-runner-upgrade.pending.json");
  const progressPath = path.join(
    paths.harnessDir,
    "p-dev-runner-upgrade.progress.json",
  );
  if (pending) {
    try {
      await rename(pendingPath, path.join(archivedDir, "p-dev-runner-upgrade.pending.json"));
    } catch {
      await writeFile(
        path.join(archivedDir, "p-dev-runner-upgrade.pending.json"),
        `${JSON.stringify(pending, null, 2)}\n`,
        "utf8",
      );
      await clearRunnerUpgradePendingState(cwd);
    }
  }
  if (progress) {
    try {
      await rename(
        progressPath,
        path.join(archivedDir, "p-dev-runner-upgrade.progress.json"),
      );
    } catch {
      await writeFile(
        path.join(archivedDir, "p-dev-runner-upgrade.progress.json"),
        `${JSON.stringify(progress, null, 2)}\n`,
        "utf8",
      );
      await clearRunnerUpgradeProgress(cwd);
    }
  }

  await writeFile(
    path.join(archivedDir, "CANCELLED.md"),
    [
      "# Runner upgrade pending cancelled",
      "",
      "Cancelled by `release:sync-managed-runner` to prevent automatic resume.",
      "",
      pending
        ? [
            "## Prior pending evidence",
            "",
            `- operationId: ${pending.operationId}`,
            `- phase: ${pending.phase}`,
            `- codeUpdateComplete: ${pending.codeUpdateComplete}`,
            `- branchName: ${pending.branchName ?? "(none)"}`,
            `- prUrl: ${pending.prUrl ?? "(none)"}`,
            `- canaryRunUrl: ${pending.canaryRunUrl ?? "(none)"}`,
            `- lastError: ${pending.lastError ?? "(none)"}`,
            "",
          ].join("\n")
        : "",
      "",
    ].join("\n"),
    "utf8",
  );

  // Ensure active files are gone even if rename moved them.
  await clearRunnerUpgradePendingState(cwd);
  await clearRunnerUpgradeProgress(cwd);

  return {
    cancelled: true,
    archivedDir,
    pending,
    remoteMutationEvidence: {
      hadBranchName: Boolean(pending?.branchName),
      hadPrUrl: Boolean(pending?.prUrl),
      hadCanaryRunUrl: Boolean(pending?.canaryRunUrl),
      codeUpdateComplete: Boolean(pending?.codeUpdateComplete),
    },
  };
}

async function pollCanary(
  provider: RunnerUpgradeGitHubProvider,
  input: {
    owner: string;
    repo: string;
    runId: number;
    pollIntervalMs: number;
    pollTimeoutMs: number;
  },
): Promise<
  | { ok: true; htmlUrl: string }
  | { ok: false; htmlUrl?: string; message: string }
> {
  const started = Date.now();
  let lastUrl: string | undefined;
  while (Date.now() - started < input.pollTimeoutMs) {
    const run = await provider.getWorkflowRun(
      input.owner,
      input.repo,
      input.runId,
    );
    lastUrl = run.htmlUrl;
    if (run.status === "completed") {
      if (run.conclusion === "success") {
        return { ok: true, htmlUrl: run.htmlUrl };
      }
      return {
        ok: false,
        htmlUrl: run.htmlUrl,
        message: `Configuration canary failed with conclusion ${run.conclusion ?? "unknown"}.`,
      };
    }
    await new Promise((resolve) => setTimeout(resolve, input.pollIntervalMs));
  }
  return {
    ok: false,
    htmlUrl: lastUrl,
    message: `Configuration canary timed out after ${input.pollTimeoutMs}ms.`,
  };
}

async function syncCloudAndCanary(input: {
  cwd: string;
  provider: RunnerUpgradeGitHubProvider;
  owner: string;
  repo: string;
  repoSlug: string;
  canaryPollIntervalMs: number;
  canaryPollTimeoutMs: number;
}): Promise<{
  fingerprint: string;
  canaryRunId: string;
  canaryRunUrl: string;
}> {
  const syncResult = await syncHarnessConfigCloudPair({
    cwd: input.cwd,
    provider: asRemoteSetupProviderForRunnerUpgrade(input.provider),
    harnessRepository: input.repoSlug,
  });

  const canaryOperationId = randomUUID();
  // GitHub workflow_dispatch returns 204 with no run id — do not require one.
  await input.provider.dispatchWorkflow(
    input.owner,
    input.repo,
    RUNNER_UPGRADE_CANARY_WORKFLOW_PATH,
    "main",
    { [CANARY_OPERATION_ID_INPUT]: canaryOperationId },
  );

  const located = await locateCanaryRunByOperationId(input.provider, {
    owner: input.owner,
    repo: input.repo,
    operationId: canaryOperationId,
    ref: "main",
    pollIntervalMs: input.canaryPollIntervalMs,
    pollTimeoutMs: Math.min(input.canaryPollTimeoutMs, 60_000),
  });
  if (!located) {
    throw new ReleaseSyncManagedRunnerError(
      "run_configuration_canary",
      `Could not locate canary workflow run for operation id ${canaryOperationId} after workflow_dispatch (204).`,
    );
  }

  const canary = await pollCanary(input.provider, {
    owner: input.owner,
    repo: input.repo,
    runId: located.id,
    pollIntervalMs: input.canaryPollIntervalMs,
    pollTimeoutMs: input.canaryPollTimeoutMs,
  });
  const canaryRunUrl =
    canary.htmlUrl ??
    located.htmlUrl ??
    `https://github.com/${input.owner}/${input.repo}/actions/runs/${located.id}`;
  if (!canary.ok) {
    throw new ReleaseSyncManagedRunnerError(
      "run_configuration_canary",
      `${canary.message} Canary URL: ${canaryRunUrl}`,
    );
  }

  return {
    fingerprint: syncResult.fingerprint,
    canaryRunId: String(located.id),
    canaryRunUrl,
  };
}

/**
 * Release-unblocker: upgrade one known managed harness repo, sync cloud config,
 * and require the real GitHub Actions configuration canary to pass.
 *
 * Never calls Linear, Cursor, Vercel, or target-application workflows.
 */
export async function runReleaseSyncManagedRunner(
  provider: RunnerUpgradeGitHubProvider,
  options: ReleaseSyncManagedRunnerOptions,
): Promise<ReleaseSyncManagedRunnerResult> {
  const cwd = options.cwd;
  const expectedRepoSlug =
    options.expectedRepoSlug ?? RELEASE_SYNC_EXPECTED_REPO_SLUG;
  const expectedRepositoryId =
    options.expectedRepositoryId ?? RELEASE_SYNC_EXPECTED_REPOSITORY_ID;
  const overallTimeoutMs =
    options.overallTimeoutMs ?? RELEASE_SYNC_OVERALL_TIMEOUT_MS;
  const canaryPollIntervalMs =
    options.canaryPollIntervalMs ?? RELEASE_SYNC_CANARY_POLL_INTERVAL_MS;
  const canaryPollTimeoutMs =
    options.canaryPollTimeoutMs ?? RELEASE_SYNC_CANARY_POLL_TIMEOUT_MS;

  const overallDeadline = AbortSignal.timeout(overallTimeoutMs);
  const throwIfTimedOut = (phase: ReleaseSyncManagedRunnerPhase) => {
    if (overallDeadline.aborted) {
      throw new ReleaseSyncManagedRunnerError(
        phase,
        `Overall release sync deadline exceeded after ${overallTimeoutMs}ms.`,
      );
    }
  };

  let cancel: ReleaseSyncCancelResult | undefined;
  if (options.cancelPending !== false) {
    throwIfTimedOut("cancel_pending");
    cancel = await archiveAndClearPending(cwd);
  }

  throwIfTimedOut("load_packaged_snapshot");
  let packaged = await loadEmbeddedWorkspaceSnapshot(import.meta.url);
  if (!packaged.ok) {
    // Source-checkout fallback: use monorepo packages/p-dev after prepare/pack.
    // Persist env so applyRunnerUpgrade's later snapshot loads resolve the same root.
    const monorepoPackageRoot = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../packages/p-dev",
    );
    process.env.P_DEV_RUNTIME_MODE = "packaged";
    process.env[P_DEV_PACKAGE_ROOT_ENV] = monorepoPackageRoot;
    packaged = await loadEmbeddedWorkspaceSnapshot(import.meta.url);
  }
  if (!packaged.ok) {
    throw new ReleaseSyncManagedRunnerError(
      "load_packaged_snapshot",
      `${packaged.message} Ensure packages/p-dev/workspace-snapshot exists (npm run package:p-dev:prepare) or run from an installed p-dev-harness package.`,
    );
  }
  const packagedSnapshotContentId = packaged.manifest.snapshotContentId;

  throwIfTimedOut("resolve_repository");
  const [owner, repo] = expectedRepoSlug.split("/");
  if (!owner || !repo) {
    throw new ReleaseSyncManagedRunnerError(
      "resolve_repository",
      `Invalid expected repository slug ${expectedRepoSlug}.`,
    );
  }

  const metadata = await provider.getRepositoryMetadata(owner, repo);
  if (!metadata) {
    throw new ReleaseSyncManagedRunnerError(
      "resolve_repository",
      `Repository ${expectedRepoSlug} is not accessible.`,
    );
  }
  if (metadata.id !== expectedRepositoryId) {
    throw new ReleaseSyncManagedRunnerError(
      "resolve_repository",
      `Repository ID mismatch for ${expectedRepoSlug}: expected ${expectedRepositoryId}, got ${metadata.id}.`,
    );
  }
  if (metadata.fullName !== expectedRepoSlug) {
    throw new ReleaseSyncManagedRunnerError(
      "resolve_repository",
      `Repository full name mismatch: expected ${expectedRepoSlug}, got ${metadata.fullName}.`,
    );
  }

  throwIfTimedOut("verify_managed_marker");
  const defaultBranchHead = await provider.getRepositoryDefaultBranchHead(
    owner,
    repo,
    metadata.defaultBranch,
  );
  const markerRaw = await provider.readRepositoryFileContent(
    owner,
    repo,
    HARNESS_MANAGED_REPO_MARKER_FILE,
    defaultBranchHead,
  );
  if (!markerRaw) {
    throw new ReleaseSyncManagedRunnerError(
      "verify_managed_marker",
      `Managed repository marker missing on ${metadata.defaultBranch}.`,
    );
  }
  const parsed = parseHarnessManagedRepoMarkerJson(markerRaw);
  if (!parsed.ok) {
    throw new ReleaseSyncManagedRunnerError(
      "verify_managed_marker",
      parsed.reason,
    );
  }
  const reconnect = validateManagedMarkerForReconnect(
    parsed.marker,
    expectedRepoSlug,
    { repositoryId: metadata.id },
  );
  if (!reconnect.ok) {
    throw new ReleaseSyncManagedRunnerError(
      "verify_managed_marker",
      reconnect.reason,
    );
  }
  if (!parsed.marker.createdFromPackageSnapshot) {
    throw new ReleaseSyncManagedRunnerError(
      "verify_managed_marker",
      "Managed repository marker is missing createdFromPackageSnapshot provenance.",
    );
  }
  const remoteSnapshotContentId =
    parsed.marker.createdFromPackageSnapshot.snapshotContentId;

  throwIfTimedOut("verify_main_baseline");
  // Baseline guard: marker must describe this repository; unexpected remote
  // drift is enforced by the three-way compare inside applyRunnerUpgrade.
  if (parsed.marker.repositoryId !== expectedRepositoryId) {
    throw new ReleaseSyncManagedRunnerError(
      "verify_main_baseline",
      `Marker repositoryId ${parsed.marker.repositoryId} does not match expected ${expectedRepositoryId}.`,
    );
  }

  if (!options.apply) {
    return {
      ok: true,
      phase: "complete",
      repoSlug: expectedRepoSlug,
      repositoryId: expectedRepositoryId,
      packagedSnapshotContentId,
      remoteSnapshotContentId,
      codeUpdateSkippedBecauseAlreadyCurrent:
        remoteSnapshotContentId === packagedSnapshotContentId,
      message:
        remoteSnapshotContentId === packagedSnapshotContentId
          ? "Dry-run OK: remote already matches packaged snapshot; --apply would sync cloud config and run canary."
          : "Dry-run OK: remote differs from packaged snapshot; --apply would replace runner, sync cloud config, and run canary.",
      cancel,
    };
  }

  const alreadyCurrent =
    remoteSnapshotContentId === packagedSnapshotContentId;

  if (!alreadyCurrent) {
    throwIfTimedOut("replace_runner_snapshot");
    const applyOptions: RunnerUpgradeApplyOptions = {
      canaryPollIntervalMs,
      canaryPollTimeoutMs,
    };
    const applyResult = await applyRunnerUpgrade(cwd, provider, applyOptions);
    if (
      applyResult.status === "up_to_date" &&
      applyResult.canaryRunUrl &&
      applyResult.canaryRunId
    ) {
      return {
        ok: true,
        phase: "complete",
        repoSlug: expectedRepoSlug,
        repositoryId: expectedRepositoryId,
        packagedSnapshotContentId,
        remoteSnapshotContentId: packagedSnapshotContentId,
        codeUpdateSkippedBecauseAlreadyCurrent: false,
        prUrl: applyResult.prUrl,
        prNumber: applyResult.prNumber,
        branchName: applyResult.branchName,
        canaryRunId: applyResult.canaryRunId,
        canaryRunUrl: applyResult.canaryRunUrl,
        message:
          "Managed runner replaced, cloud config synced, and canary passed.",
        cancel,
      };
    }
    throw new ReleaseSyncManagedRunnerError(
      mapApplyPhase(applyResult.phase),
      applyResult.message ??
        `Runner upgrade failed with status ${applyResult.status} at phase ${applyResult.phase}.`,
    );
  }

  // Remote already matches packaged snapshot: sync cloud config + canary only.
  throwIfTimedOut("sync_cloud_config");
  let fingerprint: string;
  let canaryRunId: string;
  let canaryRunUrl: string;
  try {
    const synced = await syncCloudAndCanary({
      cwd,
      provider,
      owner,
      repo,
      repoSlug: expectedRepoSlug,
      canaryPollIntervalMs,
      canaryPollTimeoutMs,
    });
    fingerprint = synced.fingerprint;
    canaryRunId = synced.canaryRunId;
    canaryRunUrl = synced.canaryRunUrl;
  } catch (error) {
    if (error instanceof ReleaseSyncManagedRunnerError) {
      throw error;
    }
    const phase: ReleaseSyncManagedRunnerPhase =
      error instanceof Error && error.message.toLowerCase().includes("canary")
        ? "run_configuration_canary"
        : "sync_cloud_config";
    throw new ReleaseSyncManagedRunnerError(
      phase,
      error instanceof Error ? error.message : String(error),
    );
  }

  return {
    ok: true,
    phase: "complete",
    repoSlug: expectedRepoSlug,
    repositoryId: expectedRepositoryId,
    packagedSnapshotContentId,
    remoteSnapshotContentId,
    codeUpdateSkippedBecauseAlreadyCurrent: true,
    fingerprint,
    canaryRunId,
    canaryRunUrl,
    message:
      "Remote runner already current; cloud config synced and canary passed.",
    cancel,
  };
}

function mapApplyPhase(phase: RunnerUpgradePhase): ReleaseSyncManagedRunnerPhase {
  switch (phase) {
    case "verifying-managed-repository":
      return "verify_managed_marker";
    case "comparing-runner-snapshots":
      return "verify_main_baseline";
    case "preparing-upgrade-commit":
    case "updating-managed-runner":
    case "verifying-runner-on-production-branch":
      return "replace_runner_snapshot";
    case "synchronizing-cloud-configuration":
      return "sync_cloud_config";
    case "running-configuration-canary":
      return "run_configuration_canary";
    default:
      return "replace_runner_snapshot";
  }
}
