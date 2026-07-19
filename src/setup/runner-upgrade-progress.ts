import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { resolveLocalFilePaths } from "./setup-state.js";
import {
  runnerUpgradePhaseLabel,
  type RunnerUpgradePhase,
  type RunnerUpgradeUiPhase,
} from "./runner-upgrade-types.js";
export const RUNNER_UPGRADE_PROGRESS_FILE =
  ".harness/p-dev-runner-upgrade.progress.json";

export interface RunnerUpgradeProgressState {
  operationId: string;
  phase: RunnerUpgradePhase | string;
  uiPhase: RunnerUpgradeUiPhase;
  uiPhaseLabel: string;
  phaseStartedAt: string;
  startedAt: string;
  elapsedMs: number;
  canaryRunId?: string;
  canaryRunUrl?: string;
  prUrl?: string;
  recoveryInstruction: string;
  updatedAt: string;
  lastSuccessfulProviderCallAt?: string;
  workerHeartbeatAt?: string;
  lastCheckpoint?: string;
  filesInspected?: number;
  filesTotal?: number;
  lastCompletedBatch?: string;
  retryCount?: number;
  retryable?: boolean;
  errorCode?: string;
}

export function mapRunnerUpgradePhaseToUiPhase(
  phase: string | undefined,
): RunnerUpgradeUiPhase {
  switch (phase) {
    case "verifying-managed-repository":
    case "comparing-runner-snapshots":
    case "preparing-upgrade-commit":
    case "updating-managed-runner":
    case "verifying-runner-on-production-branch":
    case "synchronizing-cloud-configuration":
    case "running-configuration-canary":
      return phase;
    default:
      return "verifying-managed-repository";
  }
}

export function runnerUpgradeUiPhaseLabel(phase: RunnerUpgradeUiPhase): string {
  return runnerUpgradePhaseLabel(phase);
}

export function runnerUpgradeRecoveryInstruction(
  phase: string | undefined,
  operationId: string,
): string {
  return `Retry Update PDev runner to resume operation ${operationId} from checkpoint ${phase ?? "unknown"}.`;
}

function progressFilePath(cwd?: string): string {
  const paths = resolveLocalFilePaths(cwd);
  return path.join(paths.harnessDir, "p-dev-runner-upgrade.progress.json");
}

export async function writeRunnerUpgradeProgressAtomic(
  state: Omit<
    RunnerUpgradeProgressState,
    "updatedAt" | "elapsedMs" | "uiPhase" | "uiPhaseLabel" | "recoveryInstruction"
  > & {
    uiPhase?: RunnerUpgradeUiPhase;
    uiPhaseLabel?: string;
    recoveryInstruction?: string;
    elapsedMs?: number;
    updatedAt?: string;
  },
  cwd?: string,
): Promise<RunnerUpgradeProgressState> {
  const uiPhase = state.uiPhase ?? mapRunnerUpgradePhaseToUiPhase(state.phase);
  const startedAtMs = Date.parse(state.startedAt);
  const elapsedMs =
    state.elapsedMs ??
    (Number.isFinite(startedAtMs) ? Math.max(0, Date.now() - startedAtMs) : 0);
  const now = new Date().toISOString();
  const full: RunnerUpgradeProgressState = {
    operationId: state.operationId,
    phase: state.phase,
    uiPhase,
    uiPhaseLabel: state.uiPhaseLabel ?? runnerUpgradeUiPhaseLabel(uiPhase),
    phaseStartedAt: state.phaseStartedAt,
    startedAt: state.startedAt,
    elapsedMs,
    canaryRunId: state.canaryRunId,
    canaryRunUrl: state.canaryRunUrl,
    prUrl: state.prUrl,
    recoveryInstruction:
      state.recoveryInstruction ??
      runnerUpgradeRecoveryInstruction(state.phase, state.operationId),
    updatedAt: state.updatedAt ?? now,
    lastSuccessfulProviderCallAt: state.lastSuccessfulProviderCallAt,
    workerHeartbeatAt: state.workerHeartbeatAt ?? now,
    lastCheckpoint: state.lastCheckpoint ?? state.phase,
    filesInspected: state.filesInspected,
    filesTotal: state.filesTotal,
    lastCompletedBatch: state.lastCompletedBatch,
    retryCount: state.retryCount,
    retryable: state.retryable,
    errorCode: state.errorCode,
  };
  const filePath = progressFilePath(cwd);
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(full, null, 2)}\n`, "utf8");
  await rename(tempPath, filePath);
  return full;
}

export async function readRunnerUpgradeProgress(
  cwd?: string,
): Promise<RunnerUpgradeProgressState | null> {
  try {
    const raw = await readFile(progressFilePath(cwd), "utf8");
    const parsed = JSON.parse(raw) as RunnerUpgradeProgressState;
    if (typeof parsed.operationId !== "string" || typeof parsed.phase !== "string") {
      return null;
    }
    const uiPhase = parsed.uiPhase ?? mapRunnerUpgradePhaseToUiPhase(parsed.phase);
    return {
      ...parsed,
      uiPhase,
      uiPhaseLabel: parsed.uiPhaseLabel ?? runnerUpgradeUiPhaseLabel(uiPhase),
      recoveryInstruction:
        parsed.recoveryInstruction ??
        runnerUpgradeRecoveryInstruction(parsed.phase, parsed.operationId),
    };
  } catch {
    return null;
  }
}

export async function clearRunnerUpgradeProgress(cwd?: string): Promise<void> {
  try {
    await rm(progressFilePath(cwd), { force: true });
  } catch {
    // missing is fine
  }
}
