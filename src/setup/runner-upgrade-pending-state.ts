import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { resolveLocalFilePaths } from "./setup-state.js";
import type { RunnerUpgradePhase } from "./runner-upgrade-types.js";

export const RUNNER_UPGRADE_PENDING_FILE =
  ".harness/p-dev-runner-upgrade.pending.json";

export interface RunnerUpgradePendingState {
  operationId: string;
  repositoryId: number;
  repoSlug: string;
  defaultBranch: string;
  targetSnapshotContentId: string;
  expectedFingerprint?: string;
  phase: RunnerUpgradePhase;
  startedAt: string;
  previewFingerprint: string;
  syncInProgress: boolean;
  codeUpdateComplete: boolean;
  canaryRunId?: string;
  canaryRunUrl?: string;
  branchName?: string;
  prUrl?: string;
  prNumber?: number;
  conflictPaths?: string[];
  lastError?: string;
  /** Typed terminal/blocked status from the last worker attempt (when set). */
  lastStatus?: import("./runner-upgrade-types.js").RunnerUpgradeStatus;
}

const SYNC_ACTIVE_PHASES = new Set<RunnerUpgradePhase>([
  "synchronizing-cloud-configuration",
  "running-configuration-canary",
]);

const workspaceMutexes = new Map<string, Promise<void>>();

export async function withHarnessRunnerUpgradeMutex<T>(
  workspaceDir: string,
  fn: () => Promise<T>,
): Promise<T> {
  const previous = workspaceMutexes.get(workspaceDir) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.then(() => current);
  workspaceMutexes.set(workspaceDir, queued);

  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (workspaceMutexes.get(workspaceDir) === queued) {
      workspaceMutexes.delete(workspaceDir);
    }
  }
}

function pendingFilePath(cwd?: string): string {
  const paths = resolveLocalFilePaths(cwd);
  return path.join(paths.harnessDir, "p-dev-runner-upgrade.pending.json");
}

export async function readRunnerUpgradePendingState(
  cwd?: string,
): Promise<RunnerUpgradePendingState | null> {
  try {
    const raw = await readFile(pendingFilePath(cwd), "utf8");
    const parsed = JSON.parse(raw) as RunnerUpgradePendingState;
    if (
      typeof parsed.operationId !== "string" ||
      typeof parsed.repositoryId !== "number" ||
      typeof parsed.repoSlug !== "string" ||
      typeof parsed.targetSnapshotContentId !== "string" ||
      typeof parsed.previewFingerprint !== "string"
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export async function writeRunnerUpgradePendingStateAtomic(
  state: RunnerUpgradePendingState,
  cwd?: string,
): Promise<void> {
  const filePath = pendingFilePath(cwd);
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await rename(tempPath, filePath);
}

export async function clearRunnerUpgradePendingState(cwd?: string): Promise<void> {
  try {
    await rm(pendingFilePath(cwd), { force: true });
  } catch {
    // missing file is valid
  }
}

export async function isRunnerUpgradeSyncInProgress(cwd?: string): Promise<boolean> {
  const pending = await readRunnerUpgradePendingState(cwd);
  if (!pending) {
    return false;
  }
  if (pending.syncInProgress) {
    return true;
  }
  return SYNC_ACTIVE_PHASES.has(pending.phase);
}
