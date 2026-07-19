import type { HarnessConfig } from "./types.js";
import {
  resolveLinearAssociationsFromConfig,
  uniqueTeamIdsFromAssociations,
} from "./resolve-linear-workspace.js";

export async function resolveAuthoritativeLinearTeamId(input: {
  config: HarnessConfig;
  workspaceRoot?: string;
  configPath?: string;
  baseDir?: string;
}): Promise<string | undefined> {
  void input.workspaceRoot;
  void input.configPath;
  void input.baseDir;
  return resolveAuthoritativeLinearTeamIdFromConfig(input.config);
}

export function resolveAuthoritativeLinearTeamIdFromConfig(
  config: HarnessConfig,
): string | undefined {
  const associations = resolveLinearAssociationsFromConfig(config);
  if (associations.length > 0) {
    return uniqueTeamIdsFromAssociations(associations)[0];
  }

  const configuredTeamId = config.linear?.teamId?.trim();
  return configuredTeamId || undefined;
}

export function resolveAuthoritativeLinearTeamIds(
  config: HarnessConfig,
): string[] {
  const associations = resolveLinearAssociationsFromConfig(config);
  if (associations.length > 0) {
    return uniqueTeamIdsFromAssociations(associations);
  }

  const configuredTeamId = config.linear?.teamId?.trim();
  return configuredTeamId ? [configuredTeamId] : [];
}
