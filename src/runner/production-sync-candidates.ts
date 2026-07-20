import type { HarnessConfig } from "../config/types.js";
import { createLinearClient } from "../linear/writer.js";
import { listIssuesByStatus } from "../linear/issue-query.js";

export interface ProductionSyncTeamScan {
  teamId: string;
  teamKey: string;
  projectNames?: string[];
}

/**
 * Resolve Linear teams/projects to scan for Merged-to-Dev candidates.
 * Prefer repos[].linearAssociations; fall back to linear.teamKey + linearProjects.
 */
export function resolveProductionSyncTeamScans(
  config: HarnessConfig,
  repoConfigId: string,
): ProductionSyncTeamScan[] {
  const repoConfig = config.repos.find((repo) => repo.id === repoConfigId);
  if (!repoConfig) {
    return [];
  }

  const associations = repoConfig.linearAssociations ?? [];
  if (associations.length > 0) {
    const byTeam = new Map<string, ProductionSyncTeamScan>();
    for (const association of associations) {
      const existing = byTeam.get(association.teamId);
      if (existing) {
        const projects = new Set([
          ...(existing.projectNames ?? []),
          association.projectName,
        ]);
        existing.projectNames = [...projects];
      } else {
        byTeam.set(association.teamId, {
          teamId: association.teamId,
          teamKey: association.teamKey,
          projectNames: [association.projectName],
        });
      }
    }
    return [...byTeam.values()];
  }

  const teamKey = config.linear?.teamKey;
  const teamId = config.linear?.teamId;
  if (!teamKey && !teamId) {
    return [];
  }

  return [
    {
      teamId: teamId ?? "",
      teamKey: teamKey ?? "",
      projectNames: repoConfig.linearProjects,
    },
  ];
}

export async function listProductionSyncIssueKeysForRepo(input: {
  config: HarnessConfig;
  repoConfigId: string;
  linearApiKey: string;
}): Promise<string[]> {
  const repoConfig = input.config.repos.find(
    (repo) => repo.id === input.repoConfigId,
  );
  if (!repoConfig) {
    throw new Error(`unknown_repo_id: ${input.repoConfigId}`);
  }

  const scans = resolveProductionSyncTeamScans(input.config, input.repoConfigId);
  if (scans.length === 0) {
    throw new Error(
      "No Linear teams configured for production sync. Add linearAssociations or linear.teamKey.",
    );
  }

  const integrationStatus =
    repoConfig.integrationSuccessStatus ?? "Merged to Dev";
  const client = createLinearClient(input.linearApiKey);
  const teams = await client.teams();
  const teamNodes = teams.nodes ?? [];
  const seen = new Set<string>();
  const issueKeys: string[] = [];

  for (const scan of scans) {
    let teamId = scan.teamId;
    if (!teamId && scan.teamKey) {
      const team = teamNodes.find((node) => node.key === scan.teamKey);
      if (!team) {
        throw new Error(`Linear team not found for key: ${scan.teamKey}`);
      }
      teamId = team.id;
    }
    if (!teamId) {
      continue;
    }

    const issues = await listIssuesByStatus(
      client,
      teamId,
      integrationStatus,
      scan.projectNames,
    );
    for (const issue of issues) {
      if (seen.has(issue.identifier)) {
        continue;
      }
      seen.add(issue.identifier);
      issueKeys.push(issue.identifier);
    }
  }

  return issueKeys;
}
