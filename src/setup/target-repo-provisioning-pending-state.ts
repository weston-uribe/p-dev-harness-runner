import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { resolveLocalFilePaths } from "./setup-state.js";

export const TARGET_REPO_PROVISIONING_DIR = "target-repo-provisioning";

export type TargetRepoProvisioningPhase =
  | "pending-preview"
  | "repository-created"
  | "main-verified"
  | "default-branch-corrected"
  | "bootstrap-committed"
  | "dev-created"
  | "verified-complete";

export type TargetRepoProvisioningCompletionState =
  | "incomplete"
  | "complete"
  | "setup-incomplete";

export interface TargetRepoProvisioningPendingState {
  operationId: string;
  creationActionId: string;
  createdAt: string;
  authenticatedUserId: number;
  authenticatedLogin: string;
  targetOwner: string;
  targetRepo: string;
  repositoryFullName: string;
  visibility: "private" | "public";
  description: string;
  previewFingerprint: string;
  startedAt: string;
  phase: TargetRepoProvisioningPhase;
  completionState: TargetRepoProvisioningCompletionState;
  repositoryId?: number;
  mainSha?: string;
  devSha?: string;
  markerPath: string;
  markerContentHash?: string;
  defaultBranchCorrected?: boolean;
}

const workspaceMutexes = new Map<string, Promise<void>>();

export async function withTargetRepoProvisioningMutex<T>(
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

function provisioningDir(cwd?: string): string {
  const paths = resolveLocalFilePaths(cwd);
  return path.join(paths.harnessDir, TARGET_REPO_PROVISIONING_DIR);
}

function pendingFilePath(operationId: string, cwd?: string): string {
  return path.join(provisioningDir(cwd), `${operationId}.json`);
}

export async function readTargetRepoProvisioningPendingState(
  operationId: string,
  cwd?: string,
): Promise<TargetRepoProvisioningPendingState | null> {
  try {
    const raw = await readFile(pendingFilePath(operationId, cwd), "utf8");
    const parsed = JSON.parse(raw) as TargetRepoProvisioningPendingState;
    if (
      typeof parsed.operationId !== "string" ||
      typeof parsed.creationActionId !== "string" ||
      typeof parsed.createdAt !== "string" ||
      typeof parsed.previewFingerprint !== "string"
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export async function writeTargetRepoProvisioningPendingStateAtomic(
  state: TargetRepoProvisioningPendingState,
  cwd?: string,
): Promise<void> {
  const dir = provisioningDir(cwd);
  await mkdir(dir, { recursive: true });
  const filePath = pendingFilePath(state.operationId, cwd);
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await rename(tempPath, filePath);
}

export async function listTargetRepoProvisioningPendingStates(
  cwd?: string,
): Promise<TargetRepoProvisioningPendingState[]> {
  const dir = provisioningDir(cwd);
  try {
    const entries = await readdir(dir);
    const states: TargetRepoProvisioningPendingState[] = [];
    for (const entry of entries) {
      if (!entry.endsWith(".json")) {
        continue;
      }
      const operationId = entry.replace(/\.json$/, "");
      const state = await readTargetRepoProvisioningPendingState(operationId, cwd);
      if (state) {
        states.push(state);
      }
    }
    return states;
  } catch {
    return [];
  }
}

export function validateTargetRepoPendingResume(
  pending: TargetRepoProvisioningPendingState,
  input: {
    operationId: string;
    creationActionId: string;
    owner: string;
    repositoryFullName: string;
    previewFingerprint: string;
  },
): { ok: true } | { ok: false; reason: string } {
  if (pending.operationId !== input.operationId) {
    return { ok: false, reason: "Provisioning operation ID does not match." };
  }
  if (pending.creationActionId !== input.creationActionId) {
    return { ok: false, reason: "Provisioning creation action ID does not match." };
  }
  if (pending.repositoryFullName !== input.repositoryFullName) {
    return { ok: false, reason: "Provisioning repository name does not match." };
  }
  if (`${pending.targetOwner}/${pending.targetRepo}` !== input.repositoryFullName) {
    return { ok: false, reason: "Provisioning owner/repo does not match." };
  }
  if (pending.previewFingerprint !== input.previewFingerprint) {
    return { ok: false, reason: "Provisioning preview fingerprint does not match." };
  }
  return { ok: true };
}
