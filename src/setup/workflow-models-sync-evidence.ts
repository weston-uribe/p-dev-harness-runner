import {
  readControlPlaneSetupState,
  updateControlPlaneSetupState,
} from "./control-plane-setup-state.js";

export interface WorkflowModelsSyncEvidence {
  configFingerprint: string;
  harnessRepository: string;
  syncedAt: string;
}

export async function readWorkflowModelsSyncEvidence(
  cwd?: string,
): Promise<WorkflowModelsSyncEvidence | null> {
  const state = await readControlPlaneSetupState(cwd);
  return state?.workflowModels ?? null;
}

export async function recordWorkflowModelsSyncEvidence(
  input: WorkflowModelsSyncEvidence,
  cwd?: string,
): Promise<void> {
  await updateControlPlaneSetupState({ workflowModels: input }, cwd);
}

export function isWorkflowCloudConfigSynchronized(input: {
  currentFingerprint: string;
  evidence: WorkflowModelsSyncEvidence | null;
}): boolean {
  if (!input.evidence) {
    return false;
  }
  return input.evidence.configFingerprint === input.currentFingerprint;
}
