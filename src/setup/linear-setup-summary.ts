import { readExistingEnvFile } from "./env-merge.js";
import { readControlPlaneSetupState } from "./control-plane-setup-state.js";
import type { ControlPlaneSetupState } from "./control-plane-types.js";
import { getLinearSetupCapabilities } from "./linear-setup-client.js";
import { summarizeLinearWorkspaceStatus } from "./control-plane-readiness.js";
import { getDispatchTriggerStatuses } from "./linear-status-contract.js";
import { resolveLocalFilePaths } from "./setup-state.js";

export interface LinearSetupSummary {
  capabilities: ReturnType<typeof getLinearSetupCapabilities>;
  controlPlane: ControlPlaneSetupState | null;
  workspace: ReturnType<typeof summarizeLinearWorkspaceStatus>;
  dispatchTriggerStatuses: readonly string[];
  linearApiKeyConfigured: boolean;
}

export async function buildLinearSetupSummary(
  cwd?: string,
): Promise<LinearSetupSummary> {
  const paths = resolveLocalFilePaths(cwd);
  const existingEnv = await readExistingEnvFile(paths);
  const controlPlane = await readControlPlaneSetupState(cwd);

  return {
    capabilities: getLinearSetupCapabilities(),
    controlPlane,
    workspace: summarizeLinearWorkspaceStatus({
      state: controlPlane,
    }),
    dispatchTriggerStatuses: getDispatchTriggerStatuses(),
    linearApiKeyConfigured: Boolean(existingEnv?.presence.LINEAR_API_KEY),
  };
}
