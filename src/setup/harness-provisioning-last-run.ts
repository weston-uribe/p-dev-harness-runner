import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { resolveLocalFilePaths } from "./setup-state.js";
import type { HarnessRepoProvisioningTimings } from "./harness-repo-provisioning.js";

export const HARNESS_PROVISIONING_LAST_RUN_FILE =
  ".harness/p-dev-harness-provisioning.last-run.json";

export type HarnessProvisioningLastRunPhase =
  | "authentication"
  | "repository-reconciliation"
  | "object-import"
  | "commit-creation"
  | "push"
  | "remote-verification"
  | "local-persistence";

export interface HarnessProvisioningLastRunPhaseTiming {
  phase: HarnessProvisioningLastRunPhase;
  durationMs: number;
}

export interface HarnessProvisioningLastRunState {
  operationId: string;
  outcome: "success" | "failure";
  completedAt: string;
  phases: HarnessProvisioningLastRunPhaseTiming[];
  totalMs: number;
}

export type HarnessProvisioningTimingsInput = HarnessRepoProvisioningTimings & {
  authenticationMs?: number;
};

function lastRunFilePath(cwd?: string): string {
  const paths = resolveLocalFilePaths(cwd);
  return path.join(paths.harnessDir, "p-dev-harness-provisioning.last-run.json");
}

export function mapProvisioningTimingsToLastRunPhases(
  timings: HarnessProvisioningTimingsInput,
): HarnessProvisioningLastRunPhaseTiming[] {
  const phases: HarnessProvisioningLastRunPhaseTiming[] = [];

  if (timings.authenticationMs !== undefined) {
    phases.push({
      phase: "authentication",
      durationMs: timings.authenticationMs,
    });
  }

  const snapshot = timings.snapshotProvisioning;
  if (snapshot?.repositoryCreateReconcileMs !== undefined) {
    phases.push({
      phase: "repository-reconciliation",
      durationMs: snapshot.repositoryCreateReconcileMs,
    });
  }

  const git = snapshot?.gitTransport;
  const objectImportMs =
    (git?.objectTreePreparationMs ?? 0) +
    (git?.packCreationMs ?? 0) +
    (snapshot?.workspaceUploadMs ?? 0);
  if (objectImportMs > 0) {
    phases.push({
      phase: "object-import",
      durationMs: objectImportMs,
    });
  }

  const commitCreationMs =
    (git?.temporaryGitPreparationMs ?? 0) + (git?.initialRemoteFetchMs ?? 0);
  if (commitCreationMs > 0) {
    phases.push({
      phase: "commit-creation",
      durationMs: commitCreationMs,
    });
  }

  if (git?.gitPushMs !== undefined) {
    phases.push({
      phase: "push",
      durationMs: git.gitPushMs,
    });
  }

  const remoteVerificationMs =
    timings.remoteVerificationMs ?? git?.remoteVerificationMs;
  if (remoteVerificationMs !== undefined) {
    phases.push({
      phase: "remote-verification",
      durationMs: remoteVerificationMs,
    });
  }

  if (timings.localPersistenceMs !== undefined) {
    phases.push({
      phase: "local-persistence",
      durationMs: timings.localPersistenceMs,
    });
  }

  return phases;
}

export async function writeHarnessProvisioningLastRunAtomic(
  state: HarnessProvisioningLastRunState,
  cwd?: string,
): Promise<HarnessProvisioningLastRunState> {
  const filePath = lastRunFilePath(cwd);
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await rename(tempPath, filePath);
  return state;
}

export async function readHarnessProvisioningLastRun(
  cwd?: string,
): Promise<HarnessProvisioningLastRunState | null> {
  try {
    const raw = await readFile(lastRunFilePath(cwd), "utf8");
    const parsed = JSON.parse(raw) as HarnessProvisioningLastRunState;
    if (typeof parsed.operationId !== "string" || !Array.isArray(parsed.phases)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export async function persistHarnessProvisioningLastRun(input: {
  cwd?: string;
  operationId: string;
  outcome: HarnessProvisioningLastRunState["outcome"];
  timings: HarnessProvisioningTimingsInput;
}): Promise<HarnessProvisioningLastRunState> {
  const phases = mapProvisioningTimingsToLastRunPhases(input.timings);
  const totalMs = phases.reduce((sum, entry) => sum + entry.durationMs, 0);
  return writeHarnessProvisioningLastRunAtomic(
    {
      operationId: input.operationId,
      outcome: input.outcome,
      completedAt: new Date().toISOString(),
      phases,
      totalMs,
    },
    input.cwd,
  );
}
