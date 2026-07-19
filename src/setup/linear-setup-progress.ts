import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { resolveLocalFilePaths } from "./setup-state.js";

export const LINEAR_SETUP_PROGRESS_FILE = "p-dev-linear-setup.progress.json";

export type LinearSetupProgressPhase =
  | "validate"
  | "team"
  | "project"
  | "statuses"
  | "verify";

export interface LinearSetupProgressState {
  actionId: string;
  phase: LinearSetupProgressPhase;
  phaseStartedAt: string;
  startedAt: string;
  elapsedMs: number;
  completed: boolean;
  updatedAt: string;
}

export interface LinearSetupProgressReport {
  actionId: string | null;
  phase: LinearSetupProgressPhase | null;
  uiPhaseLabel: string | null;
  phaseStartedAt: string | null;
  startedAt: string | null;
  elapsedMs: number | null;
  completed: boolean;
}

export function linearSetupPhaseLabel(phase: LinearSetupProgressPhase): string {
  switch (phase) {
    case "validate":
      return "Validating Linear plan";
    case "team":
      return "Creating or selecting team";
    case "project":
      return "Creating or selecting project";
    case "statuses":
      return "Configuring workflow statuses";
    case "verify":
      return "Verifying Linear workspace";
  }
}

function progressFilePath(cwd?: string): string {
  const paths = resolveLocalFilePaths(cwd);
  return path.join(paths.harnessDir, LINEAR_SETUP_PROGRESS_FILE);
}

export async function writeLinearSetupProgress(input: {
  actionId: string;
  phase: LinearSetupProgressPhase;
  startedAt: string;
  completed?: boolean;
}, cwd?: string): Promise<LinearSetupProgressState> {
  const startedAtMs = Date.parse(input.startedAt);
  const state: LinearSetupProgressState = {
    actionId: input.actionId,
    phase: input.phase,
    phaseStartedAt: new Date().toISOString(),
    startedAt: input.startedAt,
    elapsedMs: Number.isFinite(startedAtMs)
      ? Math.max(0, Date.now() - startedAtMs)
      : 0,
    completed: input.completed ?? false,
    updatedAt: new Date().toISOString(),
  };
  const filePath = progressFilePath(cwd);
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await rename(tempPath, filePath);
  return state;
}

export async function readLinearSetupProgress(
  cwd?: string,
): Promise<LinearSetupProgressState | null> {
  try {
    const raw = await readFile(progressFilePath(cwd), "utf8");
    const parsed = JSON.parse(raw) as LinearSetupProgressState;
    if (
      typeof parsed.actionId !== "string" ||
      typeof parsed.phase !== "string"
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export async function loadLinearSetupProgressReport(
  cwd?: string,
): Promise<LinearSetupProgressReport> {
  const progress = await readLinearSetupProgress(cwd);
  return {
    actionId: progress?.actionId ?? null,
    phase: progress?.phase ?? null,
    uiPhaseLabel: progress?.phase
      ? linearSetupPhaseLabel(progress.phase)
      : null,
    phaseStartedAt: progress?.phaseStartedAt ?? null,
    startedAt: progress?.startedAt ?? null,
    elapsedMs: progress?.elapsedMs ?? null,
    completed: progress?.completed ?? false,
  };
}
