import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { resolveLocalFilePaths } from "./setup-state.js";
import type { WorkflowInstallLifecycle } from "./target-workflow-finalization-types.js";

export const TARGET_WORKFLOW_FINALIZATION_SCHEMA_VERSION = 1 as const;

export const TARGET_WORKFLOW_FINALIZATION_DIR =
  ".harness/target-workflow-finalization";

export type TargetWorkflowFinalizationPhase =
  | WorkflowInstallLifecycle
  | "preparing-workflow-installation"
  | "creating-or-refreshing-install-branch"
  | "verifying-install-pull-request"
  | "waiting-for-github-checks"
  | "merging-workflow-installation"
  | "verifying-production-workflow";

export interface TargetWorkflowFinalizationProgressState {
  schemaVersion: typeof TARGET_WORKFLOW_FINALIZATION_SCHEMA_VERSION;
  operationId: string;
  repoConfigId: string;
  inputFingerprint: string;
  intendedWorkflowSha256: string;
  harnessDispatchRepo: string;
  targetRepo: string;
  targetRepoSlug: string;
  productionBranch: string;
  installBranch: string;
  observedProductionHeadSha?: string;
  observedInstallHeadSha?: string;
  prNumber?: number;
  prUrl?: string;
  supersededPrNumber?: number;
  phase: TargetWorkflowFinalizationPhase;
  phaseStartedAt: string;
  startedAt: string;
  elapsedMs: number;
  checksDeadlineAt?: string;
  verificationDeadlineAt?: string;
  lastVerifiedRemoteHead?: string;
  lastSafeCheckpoint: string;
  retryCount: number;
  lastRedactedError?: string;
  recoveryInstruction: string;
  updatedAt: string;
}

function progressDir(cwd?: string): string {
  const paths = resolveLocalFilePaths(cwd);
  return path.join(paths.harnessDir, "target-workflow-finalization");
}

export function targetWorkflowFinalizationProgressPath(
  repoConfigId: string,
  cwd?: string,
): string {
  const safeId = repoConfigId.replace(/[^a-zA-Z0-9._-]/g, "_");
  return path.join(progressDir(cwd), `${safeId}.json`);
}

export function recoveryInstructionForFinalization(
  phase: string,
  operationId: string,
): string {
  return `Retry Step 7 to resume workflow install operation ${operationId} from checkpoint ${phase}.`;
}

export async function writeTargetWorkflowFinalizationProgressAtomic(
  state: Omit<
    TargetWorkflowFinalizationProgressState,
    "updatedAt" | "elapsedMs" | "schemaVersion" | "recoveryInstruction"
  > & {
    schemaVersion?: typeof TARGET_WORKFLOW_FINALIZATION_SCHEMA_VERSION;
    recoveryInstruction?: string;
    elapsedMs?: number;
  },
  cwd?: string,
): Promise<TargetWorkflowFinalizationProgressState> {
  const startedAtMs = Date.parse(state.startedAt);
  const elapsedMs =
    state.elapsedMs ??
    (Number.isFinite(startedAtMs) ? Math.max(0, Date.now() - startedAtMs) : 0);
  const full: TargetWorkflowFinalizationProgressState = {
    schemaVersion:
      state.schemaVersion ?? TARGET_WORKFLOW_FINALIZATION_SCHEMA_VERSION,
    operationId: state.operationId,
    repoConfigId: state.repoConfigId,
    inputFingerprint: state.inputFingerprint,
    intendedWorkflowSha256: state.intendedWorkflowSha256,
    harnessDispatchRepo: state.harnessDispatchRepo,
    targetRepo: state.targetRepo,
    targetRepoSlug: state.targetRepoSlug,
    productionBranch: state.productionBranch,
    installBranch: state.installBranch,
    observedProductionHeadSha: state.observedProductionHeadSha,
    observedInstallHeadSha: state.observedInstallHeadSha,
    prNumber: state.prNumber,
    prUrl: state.prUrl,
    supersededPrNumber: state.supersededPrNumber,
    phase: state.phase,
    phaseStartedAt: state.phaseStartedAt,
    startedAt: state.startedAt,
    elapsedMs,
    checksDeadlineAt: state.checksDeadlineAt,
    verificationDeadlineAt: state.verificationDeadlineAt,
    lastVerifiedRemoteHead: state.lastVerifiedRemoteHead,
    lastSafeCheckpoint: state.lastSafeCheckpoint,
    retryCount: state.retryCount,
    lastRedactedError: state.lastRedactedError,
    recoveryInstruction:
      state.recoveryInstruction ??
      recoveryInstructionForFinalization(
        state.lastSafeCheckpoint || state.phase,
        state.operationId,
      ),
    updatedAt: new Date().toISOString(),
  };

  const filePath = targetWorkflowFinalizationProgressPath(
    state.repoConfigId,
    cwd,
  );
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(full, null, 2)}\n`, "utf8");
  await rename(tempPath, filePath);
  return full;
}

export async function readTargetWorkflowFinalizationProgress(
  repoConfigId: string,
  cwd?: string,
): Promise<TargetWorkflowFinalizationProgressState | null> {
  try {
    const raw = await readFile(
      targetWorkflowFinalizationProgressPath(repoConfigId, cwd),
      "utf8",
    );
    const parsed = JSON.parse(raw) as TargetWorkflowFinalizationProgressState;
    if (
      parsed.schemaVersion !== TARGET_WORKFLOW_FINALIZATION_SCHEMA_VERSION ||
      typeof parsed.operationId !== "string" ||
      parsed.repoConfigId !== repoConfigId
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export async function clearTargetWorkflowFinalizationProgress(
  repoConfigId: string,
  cwd?: string,
): Promise<void> {
  try {
    await rm(targetWorkflowFinalizationProgressPath(repoConfigId, cwd), {
      force: true,
    });
  } catch {
    // missing is fine
  }
}
