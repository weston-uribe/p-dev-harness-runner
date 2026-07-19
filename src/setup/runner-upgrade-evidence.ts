import {
  readControlPlaneSetupState,
  updateControlPlaneSetupState,
} from "./control-plane-setup-state.js";
import type { RunnerUpgradeStatus } from "./runner-upgrade-types.js";

export interface RunnerUpgradeEvidence {
  appliedSnapshotContentId?: string;
  appliedAt?: string;
  targetSnapshotContentId?: string;
  repositoryId?: number;
  lastOperationId?: string;
  syncInProgress?: boolean;
  status?: RunnerUpgradeStatus;
  canaryRunUrl?: string;
}

export async function readRunnerUpgradeEvidence(
  cwd?: string,
): Promise<RunnerUpgradeEvidence | null> {
  const state = await readControlPlaneSetupState(cwd);
  return state?.runnerUpgrade ?? null;
}

export async function recordRunnerUpgradeEvidence(
  input: RunnerUpgradeEvidence,
  cwd?: string,
): Promise<void> {
  await updateControlPlaneSetupState({ runnerUpgrade: input }, cwd);
}
