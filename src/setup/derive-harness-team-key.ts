import { deriveHarnessTeamKeys } from "./harness-team-keys.js";
import type { ControlPlaneSetupState } from "./control-plane-types.js";
import type { HarnessConfig } from "../config/types.js";

export function deriveHarnessTeamKeyFromControlPlane(
  state: ControlPlaneSetupState | null | undefined,
  config?: HarnessConfig | null,
): string | undefined {
  const associationTeamKeys =
    config?.repos.flatMap((repo) =>
      (repo.linearAssociations ?? []).map((association) => association.teamKey),
    ) ?? [];

  const derived = deriveHarnessTeamKeys({
    linearTeamKey: state?.linear?.teamKey ?? config?.linear?.teamKey,
    workspaceTeamKeys: (state?.linearWorkspace?.teams ?? []).map(
      (team) => team.teamKey,
    ),
    associationTeamKeys,
  });

  return derived || undefined;
}
