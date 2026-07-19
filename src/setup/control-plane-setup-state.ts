import { writeFile, mkdir, rename } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { resolveLocalFilePaths } from "./setup-state.js";
import { readTextFileSyncIfExists } from "./rsc-safe-fs.js";
import type {
  ControlPlaneSetupState,
  VercelBridgeSelection,
} from "./control-plane-types.js";

export type {
  ControlPlaneSetupState,
  ControlPlaneReadinessContext,
  LinearWorkspaceSelection,
  LinearWorkspaceEvidence,
  LinearTeamEvidence,
  LinearProjectEvidence,
  VercelBridgeSelection,
} from "./control-plane-types.js";

const STATE_FILE = path.join(".harness", "control-plane-setup.json");

function statePath(cwd?: string): string {
  const paths = resolveLocalFilePaths(cwd);
  return path.join(paths.cwd, STATE_FILE);
}

export async function readControlPlaneSetupState(
  cwd?: string,
): Promise<ControlPlaneSetupState | null> {
  const filePath = statePath(cwd);
  try {
    // Sync read: avoids Next.js Flight async-debug serializing control-plane JSON.
    const raw = readTextFileSyncIfExists(filePath);
    if (raw === null) {
      return null;
    }
    const parsed = JSON.parse(raw) as ControlPlaneSetupState;
    if (parsed.version !== 1) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export async function writeControlPlaneSetupState(
  state: ControlPlaneSetupState,
  cwd?: string,
): Promise<void> {
  const paths = resolveLocalFilePaths(cwd);
  await mkdir(paths.harnessDir, { recursive: true });
  const filePath = statePath(cwd);
  const tempPath = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(tempPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await rename(tempPath, filePath);
}

export function mergeVercelBridgeSelection(
  current: VercelBridgeSelection | undefined,
  patch: Partial<VercelBridgeSelection>,
): VercelBridgeSelection {
  if (!current) {
    if (!patch.projectId || !patch.projectName) {
      throw new Error("Cannot merge vercel selection without base state.");
    }
    return patch as VercelBridgeSelection;
  }

  return {
    ...current,
    ...patch,
    redeployVerification:
      patch.redeployVerification !== undefined
        ? patch.redeployVerification
        : current.redeployVerification,
  };
}

export type ControlPlaneSetupStatePatch = {
  version?: 1;
  linear?: ControlPlaneSetupState["linear"];
  linearWorkspace?: ControlPlaneSetupState["linearWorkspace"];
  vercel?: Partial<VercelBridgeSelection>;
  workflowModels?: ControlPlaneSetupState["workflowModels"];
  optionalReviewProvisioning?: ControlPlaneSetupState["optionalReviewProvisioning"];
  runnerUpgrade?: ControlPlaneSetupState["runnerUpgrade"];
  initialSetup?: ControlPlaneSetupState["initialSetup"];
};

export async function updateControlPlaneSetupState(
  patch: ControlPlaneSetupStatePatch,
  cwd?: string,
): Promise<ControlPlaneSetupState> {
  const current = (await readControlPlaneSetupState(cwd)) ?? { version: 1 };
  const next: ControlPlaneSetupState = {
    ...current,
    ...patch,
    version: 1,
    linear: patch.linear ?? current.linear,
    linearWorkspace: patch.linearWorkspace ?? current.linearWorkspace,
    vercel:
      patch.vercel !== undefined
        ? current.vercel
          ? mergeVercelBridgeSelection(current.vercel, patch.vercel)
          : (patch.vercel as VercelBridgeSelection)
        : current.vercel,
    workflowModels: patch.workflowModels ?? current.workflowModels,
    optionalReviewProvisioning:
      patch.optionalReviewProvisioning ?? current.optionalReviewProvisioning,
    runnerUpgrade: patch.runnerUpgrade ?? current.runnerUpgrade,
    initialSetup: patch.initialSetup ?? current.initialSetup,
  };
  await writeControlPlaneSetupState(next, cwd);
  return next;
}
