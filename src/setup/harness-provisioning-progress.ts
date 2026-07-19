import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { resolveLocalFilePaths } from "./setup-state.js";
import type { HarnessProvisioningPhase } from "./harness-provisioning-pending-state.js";

export const HARNESS_PROVISIONING_PROGRESS_FILE =
  ".harness/p-dev-harness-provisioning.progress.json";

export type HarnessProvisioningUiPhase =
  | "creating-private-workspace"
  | "preparing-workspace-snapshot"
  | "uploading-workspace"
  | "verifying-workspace"
  | "saving-configuration";

export interface HarnessProvisioningProgressState {
  operationId: string;
  phase: HarnessProvisioningPhase | HarnessProvisioningUiPhase | string;
  uiPhase: HarnessProvisioningUiPhase;
  phaseStartedAt: string;
  startedAt: string;
  elapsedMs: number;
  completed?: number;
  total?: number;
  rateLimitPauseSeconds?: number;
  lastSafeCheckpoint?: string;
  recoveryInstruction: string;
  updatedAt: string;
}

export function mapProvisioningPhaseToUiPhase(
  phase: string | undefined,
): HarnessProvisioningUiPhase {
  switch (phase) {
    case "repository-created":
    case "creating-private-workspace":
      return "creating-private-workspace";
    case "preparing-snapshot":
    case "preparing-workspace-snapshot":
    case "snapshot-objects-uploading":
      return "preparing-workspace-snapshot";
    case "workspace-uploading":
    case "uploading-workspace":
      return "uploading-workspace";
    case "snapshot-commit-created":
    case "marker-pending":
    case "verifying":
    case "verifying-workspace":
      return "verifying-workspace";
    case "description-pending":
    case "persistence-pending":
    case "saving-configuration":
      return "saving-configuration";
    default:
      return "creating-private-workspace";
  }
}

export function uiPhaseLabel(phase: HarnessProvisioningUiPhase): string {
  switch (phase) {
    case "creating-private-workspace":
      return "Creating private workspace";
    case "preparing-workspace-snapshot":
      return "Preparing workspace snapshot";
    case "uploading-workspace":
      return "Uploading workspace";
    case "verifying-workspace":
      return "Verifying workspace";
    case "saving-configuration":
      return "Saving configuration";
  }
}

export function recoveryInstructionForPhase(
  phase: string | undefined,
  operationId: string,
): string {
  return `Retry Step 1 Continue to resume operation ${operationId} from checkpoint ${phase ?? "unknown"}.`;
}

function progressFilePath(cwd?: string): string {
  const paths = resolveLocalFilePaths(cwd);
  return path.join(paths.harnessDir, "p-dev-harness-provisioning.progress.json");
}

export async function writeHarnessProvisioningProgressAtomic(
  state: Omit<HarnessProvisioningProgressState, "updatedAt" | "elapsedMs" | "uiPhase" | "recoveryInstruction"> & {
    uiPhase?: HarnessProvisioningUiPhase;
    recoveryInstruction?: string;
    elapsedMs?: number;
  },
  cwd?: string,
): Promise<HarnessProvisioningProgressState> {
  const uiPhase = state.uiPhase ?? mapProvisioningPhaseToUiPhase(state.phase);
  const startedAtMs = Date.parse(state.startedAt);
  const elapsedMs =
    state.elapsedMs ??
    (Number.isFinite(startedAtMs) ? Math.max(0, Date.now() - startedAtMs) : 0);
  const full: HarnessProvisioningProgressState = {
    operationId: state.operationId,
    phase: state.phase,
    uiPhase,
    phaseStartedAt: state.phaseStartedAt,
    startedAt: state.startedAt,
    elapsedMs,
    completed: state.completed,
    total: state.total,
    rateLimitPauseSeconds: state.rateLimitPauseSeconds,
    lastSafeCheckpoint: state.lastSafeCheckpoint,
    recoveryInstruction:
      state.recoveryInstruction ??
      recoveryInstructionForPhase(state.lastSafeCheckpoint ?? state.phase, state.operationId),
    updatedAt: new Date().toISOString(),
  };
  const filePath = progressFilePath(cwd);
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(full, null, 2)}\n`, "utf8");
  await rename(tempPath, filePath);
  return full;
}

export async function readHarnessProvisioningProgress(
  cwd?: string,
): Promise<HarnessProvisioningProgressState | null> {
  try {
    const raw = await readFile(progressFilePath(cwd), "utf8");
    const parsed = JSON.parse(raw) as HarnessProvisioningProgressState;
    if (typeof parsed.operationId !== "string" || typeof parsed.phase !== "string") {
      return null;
    }
    return {
      ...parsed,
      uiPhase: parsed.uiPhase ?? mapProvisioningPhaseToUiPhase(parsed.phase),
      recoveryInstruction:
        parsed.recoveryInstruction ??
        recoveryInstructionForPhase(parsed.lastSafeCheckpoint ?? parsed.phase, parsed.operationId),
    };
  } catch {
    return null;
  }
}

export async function clearHarnessProvisioningProgress(cwd?: string): Promise<void> {
  try {
    await rm(progressFilePath(cwd), { force: true });
  } catch {
    // missing is fine
  }
}

/** Redacted diagnostic view — never includes tokens, env, or file contents. */
export interface HarnessProvisioningDiagnosticReport {
  operationId: string | null;
  phase: string | null;
  uiPhase: HarnessProvisioningUiPhase | null;
  uiPhaseLabel: string | null;
  phaseStartedAt: string | null;
  startedAt: string | null;
  elapsedMs: number | null;
  completed: number | null;
  total: number | null;
  rateLimitPauseSeconds: number | null;
  lastSafeCheckpoint: string | null;
  recoveryInstruction: string | null;
  pendingPhase: string | null;
  pendingRepositoryId: number | null;
  pendingTargetRepo: string | null;
  hasPendingState: boolean;
}

export async function loadHarnessProvisioningDiagnosticReport(input: {
  cwd?: string;
  pending?: {
    operationId?: string;
    phase?: string;
    repositoryId?: number;
    targetRepo?: string;
    targetOwner?: string;
    startedAt?: string;
  } | null;
}): Promise<HarnessProvisioningDiagnosticReport> {
  const progress = await readHarnessProvisioningProgress(input.cwd);
  const pending = input.pending;
  const operationId = progress?.operationId ?? pending?.operationId ?? null;
  const phase = progress?.phase ?? pending?.phase ?? null;
  const uiPhase = phase ? mapProvisioningPhaseToUiPhase(phase) : null;
  return {
    operationId,
    phase,
    uiPhase,
    uiPhaseLabel: uiPhase ? uiPhaseLabel(uiPhase) : null,
    phaseStartedAt: progress?.phaseStartedAt ?? null,
    startedAt: progress?.startedAt ?? pending?.startedAt ?? null,
    elapsedMs: progress?.elapsedMs ?? null,
    completed: progress?.completed ?? null,
    total: progress?.total ?? null,
    rateLimitPauseSeconds: progress?.rateLimitPauseSeconds ?? null,
    lastSafeCheckpoint: progress?.lastSafeCheckpoint ?? pending?.phase ?? null,
    recoveryInstruction:
      progress?.recoveryInstruction ??
      (operationId
        ? recoveryInstructionForPhase(phase ?? undefined, operationId)
        : null),
    pendingPhase: pending?.phase ?? null,
    pendingRepositoryId: pending?.repositoryId ?? null,
    pendingTargetRepo:
      pending?.targetOwner && pending?.targetRepo
        ? `${pending.targetOwner}/${pending.targetRepo}`
        : pending?.targetRepo ?? null,
    hasPendingState: Boolean(pending?.operationId),
  };
}
