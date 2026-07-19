import type { HarnessConfig, LinearAssociation } from "./types.js";
import {
  resolveLinearAssociationsFromConfig,
  uniqueTeamIdsFromAssociations,
} from "./resolve-linear-workspace.js";

/**
 * Derive legacy top-level linear.* fields from associations.
 * Only populate teamId/teamKey when exactly one unique team is configured.
 * Never pick an arbitrary "first" team when multiple teams exist.
 */
export function deriveLegacyLinearTopLevel(input: {
  workspaceId?: string;
  associations: Array<Pick<LinearAssociation, "workspaceId" | "teamId" | "teamKey">>;
}): {
  workspaceId?: string;
  teamId?: string;
  teamKey?: string;
} {
  const workspaceIds = [
    ...new Set(
      [
        input.workspaceId?.trim(),
        ...input.associations.map((association) => association.workspaceId.trim()),
      ].filter((value): value is string => Boolean(value)),
    ),
  ];
  const teamIds = uniqueTeamIdsFromAssociations(input.associations);
  const result: {
    workspaceId?: string;
    teamId?: string;
    teamKey?: string;
  } = {};

  if (workspaceIds.length === 1) {
    result.workspaceId = workspaceIds[0];
  }

  if (teamIds.length === 1) {
    const teamId = teamIds[0]!;
    const sample = input.associations.find(
      (association) => association.teamId === teamId,
    );
    result.teamId = teamId;
    if (sample?.teamKey?.trim()) {
      result.teamKey = sample.teamKey.trim();
    }
  }

  return result;
}

export function applyLegacyLinearTopLevelToConfig(
  config: HarnessConfig,
  workspaceId?: string,
): HarnessConfig["linear"] {
  const associations = resolveLinearAssociationsFromConfig(config);
  const derived = deriveLegacyLinearTopLevel({
    workspaceId: workspaceId ?? config.linear?.workspaceId,
    associations,
  });

  return {
    ...config.linear,
    workspaceId: derived.workspaceId,
    teamId: derived.teamId,
    teamKey: derived.teamKey,
  };
}
