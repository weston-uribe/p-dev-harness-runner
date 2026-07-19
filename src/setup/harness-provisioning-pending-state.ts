import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { resolveLocalFilePaths } from "./setup-state.js";
import { P_DEV_PACKAGE_NAME } from "../p-dev/package-paths.js";
import { WORKSPACE_SNAPSHOT_SOURCE_REPOSITORY } from "../p-dev/workspace-snapshot-types.js";

export const HARNESS_PROVISIONING_PENDING_FILE =
  ".harness/p-dev-harness-provisioning.pending.json";

export type HarnessProvisioningPhase =
  | "repository-created"
  | "preparing-snapshot"
  | "snapshot-objects-uploading"
  | "workspace-uploading"
  | "snapshot-commit-created"
  | "marker-pending"
  | "verifying"
  | "description-pending"
  | "persistence-pending";

export interface HarnessProvisioningPendingState {
  operationId: string;
  authenticatedUserId: number;
  authenticatedLogin: string;
  packageName: string;
  packageVersion: string;
  sourceRepository: string;
  sourceCommit: string;
  manifestSchemaVersion: number;
  snapshotContentId: string;
  snapshotSha256: string;
  snapshotGitTreeSha1: string;
  targetOwner: string;
  targetRepo: string;
  previewFingerprint: string;
  startedAt: string;
  phase?: HarnessProvisioningPhase;
  repositoryId?: number;
  defaultBranch?: string;
  initializedCommitSha?: string;
  snapshotCommitSha?: string;
  markerCommitSha?: string;
}

export interface PendingProvisioningValidationContext {
  operationId?: string;
  authenticatedUserId: number;
  authenticatedLogin: string;
  packageName: string;
  packageVersion: string;
  sourceRepository: string;
  sourceCommit: string;
  manifestSchemaVersion: number;
  snapshotContentId: string;
  snapshotSha256: string;
  snapshotGitTreeSha1: string;
  targetOwner: string;
  targetRepo: string;
  previewFingerprint?: string;
  defaultBranch?: string;
}

const workspaceMutexes = new Map<string, Promise<void>>();

export async function withHarnessProvisioningMutex<T>(
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
  return path.join(paths.harnessDir, "p-dev-harness-provisioning.pending.json");
}

export async function readHarnessProvisioningPendingState(
  cwd?: string,
): Promise<HarnessProvisioningPendingState | null> {
  try {
    const raw = await readFile(pendingFilePath(cwd), "utf8");
    const parsed = JSON.parse(raw) as HarnessProvisioningPendingState;
    if (
      typeof parsed.operationId !== "string" ||
      typeof parsed.authenticatedUserId !== "number" ||
      typeof parsed.previewFingerprint !== "string" ||
      typeof parsed.snapshotContentId !== "string"
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export async function writeHarnessProvisioningPendingStateAtomic(
  state: HarnessProvisioningPendingState,
  cwd?: string,
): Promise<void> {
  const filePath = pendingFilePath(cwd);
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await rename(tempPath, filePath);
}

export async function clearHarnessProvisioningPendingState(
  cwd?: string,
): Promise<void> {
  try {
    await rm(pendingFilePath(cwd), { force: true });
  } catch {
    // missing file is valid
  }
}

export function validatePendingProvisioningState(
  pending: HarnessProvisioningPendingState,
  context: PendingProvisioningValidationContext,
): { ok: true } | { ok: false; reason: string } {
  if (
    context.operationId !== undefined &&
    pending.operationId !== context.operationId
  ) {
    return {
      ok: false,
      reason: "Pending provisioning operation ID does not match.",
    };
  }
  if (pending.authenticatedUserId !== context.authenticatedUserId) {
    return {
      ok: false,
      reason: "Pending provisioning authenticated user ID does not match.",
    };
  }
  if (pending.authenticatedLogin !== context.authenticatedLogin) {
    return {
      ok: false,
      reason: "Pending provisioning authenticated login does not match.",
    };
  }
  if (pending.packageName !== context.packageName) {
    return {
      ok: false,
      reason: "Pending provisioning package name does not match.",
    };
  }
  if (pending.packageVersion !== context.packageVersion) {
    return {
      ok: false,
      reason: "Pending provisioning package version does not match.",
    };
  }
  if (pending.sourceRepository !== context.sourceRepository) {
    return {
      ok: false,
      reason: "Pending provisioning source repository does not match.",
    };
  }
  if (pending.sourceCommit !== context.sourceCommit) {
    return {
      ok: false,
      reason: "Pending provisioning source commit does not match.",
    };
  }
  if (pending.manifestSchemaVersion !== context.manifestSchemaVersion) {
    return {
      ok: false,
      reason: "Pending provisioning manifest schema version does not match.",
    };
  }
  if (pending.snapshotContentId !== context.snapshotContentId) {
    return {
      ok: false,
      reason: "Pending provisioning snapshot content ID does not match.",
    };
  }
  if (pending.snapshotSha256 !== context.snapshotSha256) {
    return {
      ok: false,
      reason: "Pending provisioning snapshot digest does not match.",
    };
  }
  if (pending.snapshotGitTreeSha1 !== context.snapshotGitTreeSha1) {
    return {
      ok: false,
      reason: "Pending provisioning snapshot tree SHA does not match.",
    };
  }
  if (pending.targetOwner !== context.targetOwner) {
    return {
      ok: false,
      reason: "Pending provisioning target owner does not match.",
    };
  }
  if (pending.targetRepo !== context.targetRepo) {
    return {
      ok: false,
      reason: "Pending provisioning target repository does not match.",
    };
  }
  if (
    context.previewFingerprint !== undefined &&
    pending.previewFingerprint !== context.previewFingerprint
  ) {
    return {
      ok: false,
      reason: "Pending provisioning creation fingerprint does not match.",
    };
  }
  if (
    context.defaultBranch !== undefined &&
    pending.defaultBranch !== undefined &&
    pending.defaultBranch !== context.defaultBranch
  ) {
    return {
      ok: false,
      reason: "Pending provisioning default branch does not match.",
    };
  }
  if (
    pending.repositoryId !== undefined &&
    pending.defaultBranch === undefined &&
    context.defaultBranch !== undefined
  ) {
    return {
      ok: false,
      reason: "Pending provisioning state is missing default branch.",
    };
  }
  return { ok: true };
}

export function buildPendingValidationContext(input: {
  operationId?: string;
  authenticatedUserId: number;
  authenticatedLogin: string;
  targetOwner: string;
  targetRepo: string;
  packageName?: string;
  packageVersion: string;
  sourceRepository?: string;
  sourceCommit: string;
  manifestSchemaVersion: number;
  snapshotContentId: string;
  snapshotSha256: string;
  snapshotGitTreeSha1: string;
  previewFingerprint?: string;
  defaultBranch?: string;
}): PendingProvisioningValidationContext {
  return {
    operationId: input.operationId,
    authenticatedUserId: input.authenticatedUserId,
    authenticatedLogin: input.authenticatedLogin,
    targetOwner: input.targetOwner,
    targetRepo: input.targetRepo,
    packageName: input.packageName ?? P_DEV_PACKAGE_NAME,
    packageVersion: input.packageVersion,
    sourceRepository: input.sourceRepository ?? WORKSPACE_SNAPSHOT_SOURCE_REPOSITORY,
    sourceCommit: input.sourceCommit,
    manifestSchemaVersion: input.manifestSchemaVersion,
    snapshotContentId: input.snapshotContentId,
    snapshotSha256: input.snapshotSha256,
    snapshotGitTreeSha1: input.snapshotGitTreeSha1,
    previewFingerprint: input.previewFingerprint,
    defaultBranch: input.defaultBranch,
  };
}
