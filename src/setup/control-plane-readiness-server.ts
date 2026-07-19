import type { SetupGuiViewModel } from "./gui-view-model.js";
import { readControlPlaneSetupState } from "./control-plane-setup-state.js";
import type { ControlPlaneReadinessContext } from "./control-plane-types.js";

export async function loadControlPlaneReadinessContext(
  cwd?: string,
  summary?: SetupGuiViewModel,
): Promise<ControlPlaneReadinessContext> {
  const state = await readControlPlaneSetupState(cwd);
  return {
    state,
    linearTeamKeyFromConfig: summary?.configSummary?.linearTeamKey,
  };
}

export type { ControlPlaneReadinessContext } from "./control-plane-types.js";
