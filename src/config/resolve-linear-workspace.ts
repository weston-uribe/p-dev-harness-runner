import type { HarnessConfig, LinearAssociation, RepoMapping } from "./types.js";
import type {
  ControlPlaneSetupState,
  LinearWorkspaceEvidence,
} from "../setup/control-plane-types.js";

export type ResolvedLinearAssociation = LinearAssociation & {
  targetRepo: string;
  repoConfigId: string;
};

export type LinearAssociationKey = {
  workspaceId: string;
  teamId: string;
  projectId: string;
};

export type ResolveLinearAssociationInput = {
  workspaceId?: string;
  teamId?: string | null;
  teamKey?: string | null;
  teamName?: string | null;
  projectId?: string | null;
};

export function linearAssociationKey(
  association: LinearAssociationKey,
): string {
  return `${association.workspaceId}:${association.teamId}:${association.projectId}`;
}

function normalizeIdentity(value: string): string {
  return value.trim().toLowerCase();
}

export function resolveLinearAssociationsFromConfig(
  config: HarnessConfig,
): ResolvedLinearAssociation[] {
  const resolved: ResolvedLinearAssociation[] = [];

  for (const repo of config.repos) {
    for (const association of repo.linearAssociations ?? []) {
      resolved.push({
        ...association,
        targetRepo: repo.targetRepo,
        repoConfigId: repo.id,
      });
    }
  }

  return resolved;
}

/**
 * Resolve an issue association using:
 * 1. Exact teamId + projectId
 * 2. Exact teamId with a uniquely configured project
 * 3. Exact normalized teamKey + projectId
 * 4. Exact normalized full teamName + projectId
 * 5. null when ambiguous or unconfigured
 *
 * Never compares a full team name against a team key.
 */
export function resolveLinearAssociationForIssue(
  config: HarnessConfig,
  input: ResolveLinearAssociationInput,
): ResolvedLinearAssociation | null {
  const associations = resolveLinearAssociationsFromConfig(config);
  if (associations.length === 0) {
    return null;
  }

  const teamId = input.teamId?.trim() || undefined;
  const projectId = input.projectId?.trim() || undefined;
  const teamKey = input.teamKey?.trim() || undefined;
  const teamName = input.teamName?.trim() || undefined;
  const workspaceId = input.workspaceId?.trim() || undefined;

  const workspaceFilter = (association: ResolvedLinearAssociation): boolean => {
    if (!workspaceId) return true;
    return association.workspaceId === workspaceId;
  };

  // 1. Exact teamId + projectId
  if (teamId && projectId) {
    const exact = associations.filter(
      (association) =>
        workspaceFilter(association) &&
        association.teamId === teamId &&
        association.projectId === projectId,
    );
    if (exact.length === 1) return exact[0]!;
    if (exact.length > 1) return null;
    // Explicit wrong projectId must fail closed — do not fall through to unique-project.
  }

  // 2. Exact teamId with a uniquely configured project (only when projectId omitted)
  if (teamId && !projectId) {
    const byTeam = associations.filter(
      (association) =>
        workspaceFilter(association) && association.teamId === teamId,
    );
    if (byTeam.length === 1) return byTeam[0]!;
    return null;
  }

  // 3. Exact normalized teamKey + projectId
  if (teamKey && projectId) {
    const key = normalizeIdentity(teamKey);
    const byKey = associations.filter(
      (association) =>
        workspaceFilter(association) &&
        association.projectId === projectId &&
        normalizeIdentity(association.teamKey) === key,
    );
    if (byKey.length === 1) return byKey[0]!;
    if (byKey.length > 1) return null;
  }

  // 4. Exact normalized full teamName + projectId (never match against teamKey)
  if (teamName && projectId) {
    const name = normalizeIdentity(teamName);
    const byName = associations.filter(
      (association) =>
        workspaceFilter(association) &&
        association.projectId === projectId &&
        Boolean(association.teamName?.trim()) &&
        normalizeIdentity(association.teamName!) === name,
    );
    if (byName.length === 1) return byName[0]!;
    if (byName.length > 1) return null;
  }

  return null;
}

export type LinearAssociationAssertResult =
  | { ok: true; association: ResolvedLinearAssociation }
  | { ok: false; code: "linear_team_project_not_configured" };

export function assertLinearAssociationConfigured(
  config: HarnessConfig,
  input: ResolveLinearAssociationInput,
): LinearAssociationAssertResult {
  const association = resolveLinearAssociationForIssue(config, input);
  if (!association) {
    return { ok: false, code: "linear_team_project_not_configured" };
  }
  return { ok: true, association };
}

export type SharedProjectTargetRepoResult =
  | { ok: true }
  | {
      ok: false;
      code: "linear_project_target_repo_conflict";
      projectId: string;
      targetRepos: string[];
    };

export function assertSharedProjectTargetRepoConsistency(
  associations: Array<Pick<LinearAssociation, "projectId"> & { targetRepo: string }>,
): SharedProjectTargetRepoResult {
  const byProject = new Map<string, Set<string>>();

  for (const association of associations) {
    const existing = byProject.get(association.projectId) ?? new Set<string>();
    existing.add(association.targetRepo);
    byProject.set(association.projectId, existing);
  }

  for (const [projectId, targetRepos] of byProject.entries()) {
    if (targetRepos.size > 1) {
      return {
        ok: false,
        code: "linear_project_target_repo_conflict",
        projectId,
        targetRepos: [...targetRepos],
      };
    }
  }

  return { ok: true };
}

export function groupAssociationsByTeam(
  associations: ResolvedLinearAssociation[],
): Map<string, ResolvedLinearAssociation[]> {
  const grouped = new Map<string, ResolvedLinearAssociation[]>();
  for (const association of associations) {
    const existing = grouped.get(association.teamId) ?? [];
    existing.push(association);
    grouped.set(association.teamId, existing);
  }
  return grouped;
}

export function uniqueProjectIdsFromAssociations(
  associations: Array<Pick<LinearAssociation, "projectId">>,
): string[] {
  return [...new Set(associations.map((association) => association.projectId))];
}

export function uniqueTeamIdsFromAssociations(
  associations: Array<Pick<LinearAssociation, "teamId">>,
): string[] {
  return [...new Set(associations.map((association) => association.teamId))];
}

export function buildLinearAssociationsForRepo(input: {
  repo: RepoMapping;
  associations: LinearAssociation[];
}): LinearAssociation[] {
  return input.associations.map((association) => ({ ...association }));
}

export function hasLinearAssociationsInConfig(config: HarnessConfig): boolean {
  return config.repos.some(
    (repo) => (repo.linearAssociations?.length ?? 0) > 0,
  );
}

export function getLinearWorkspaceIdFromConfig(
  config: HarnessConfig,
): string | undefined {
  const configured = config.linear?.workspaceId?.trim();
  if (configured) {
    return configured;
  }

  const associations = resolveLinearAssociationsFromConfig(config);
  const workspaceIds = [
    ...new Set(associations.map((association) => association.workspaceId)),
  ];
  return workspaceIds.length === 1 ? workspaceIds[0] : undefined;
}

export function formatLinearTeamLabel(association: {
  teamName?: string;
  teamKey: string;
}): string {
  const name = association.teamName?.trim();
  if (name && name !== association.teamKey) {
    return `${name} (${association.teamKey})`;
  }
  if (name) {
    return name;
  }
  return association.teamKey;
}

export function evidenceFromAssociations(input: {
  workspaceId: string;
  workspaceName: string;
  associations: ResolvedLinearAssociation[];
  appliedFingerprint?: string;
  appliedAt?: string;
  migratedFromVersion?: LinearWorkspaceEvidence["migratedFromVersion"];
  migratedAt?: string;
}): LinearWorkspaceEvidence {
  const teams = new Map<
    string,
    {
      teamId: string;
      teamKey: string;
      teamName: string;
      projects: LinearWorkspaceEvidence["teams"][number]["projects"];
      lastVerifiedAt?: string;
    }
  >();

  for (const association of input.associations) {
    // Never copy teamKey into teamName — legacy associations without a name stay unnamed.
    const teamName = association.teamName?.trim() || "(unnamed team)";
    const team =
      teams.get(association.teamId) ??
      {
        teamId: association.teamId,
        teamKey: association.teamKey,
        teamName,
        projects: [],
      };

    if (association.teamName?.trim()) {
      team.teamName = association.teamName.trim();
    }

    if (!team.projects.some((project) => project.projectId === association.projectId)) {
      team.projects.push({
        projectId: association.projectId,
        projectName: association.projectName,
        targetRepo: association.targetRepo,
        health: "verification_pending",
      });
    }

    teams.set(association.teamId, team);
  }

  return {
    workspaceId: input.workspaceId,
    workspaceName: input.workspaceName,
    teams: [...teams.values()].map((team) => ({
      ...team,
      health: "verification_pending" as const,
    })),
    appliedFingerprint: input.appliedFingerprint,
    appliedAt: input.appliedAt,
    migratedFromVersion: input.migratedFromVersion,
    migratedAt: input.migratedAt,
  };
}

export type ConfigControlPlaneDriftFinding = {
  code:
    | "association_count_mismatch"
    | "team_id_mismatch"
    | "project_id_mismatch"
    | "workspace_id_mismatch"
    | "target_repo_mismatch";
  message: string;
  teamId?: string;
  projectId?: string;
};

export function detectConfigControlPlaneDrift(input: {
  config: HarnessConfig;
  controlPlane: ControlPlaneSetupState | null;
}): ConfigControlPlaneDriftFinding[] {
  const findings: ConfigControlPlaneDriftFinding[] = [];
  const evidence = input.controlPlane?.linearWorkspace;
  if (!evidence) {
    return findings;
  }

  const configAssociations = resolveLinearAssociationsFromConfig(input.config);
  const evidencePairs = evidence.teams.flatMap((team) =>
    team.projects.map((project) => ({
      workspaceId: evidence.workspaceId,
      teamId: team.teamId,
      projectId: project.projectId,
      targetRepo: project.targetRepo,
    })),
  );

  if (configAssociations.length !== evidencePairs.length) {
    findings.push({
      code: "association_count_mismatch",
      message: `Harness config has ${configAssociations.length} association(s) but control-plane evidence has ${evidencePairs.length}.`,
    });
  }

  const workspaceId = getLinearWorkspaceIdFromConfig(input.config);
  if (workspaceId && workspaceId !== evidence.workspaceId) {
    findings.push({
      code: "workspace_id_mismatch",
      message: `Harness config workspaceId (${workspaceId}) does not match control-plane (${evidence.workspaceId}).`,
    });
  }

  for (const configAssociation of configAssociations) {
    const evidenceMatch = evidencePairs.find(
      (pair) =>
        pair.teamId === configAssociation.teamId &&
        pair.projectId === configAssociation.projectId,
    );
    if (!evidenceMatch) {
      findings.push({
        code: "project_id_mismatch",
        message: `Association ${configAssociation.teamId}/${configAssociation.projectId} exists in harness config but not in control-plane evidence.`,
        teamId: configAssociation.teamId,
        projectId: configAssociation.projectId,
      });
      continue;
    }

    if (
      evidenceMatch.targetRepo &&
      evidenceMatch.targetRepo !== configAssociation.targetRepo
    ) {
      findings.push({
        code: "target_repo_mismatch",
        message: `Target repo for ${configAssociation.projectId} differs between harness config and control-plane evidence.`,
        teamId: configAssociation.teamId,
        projectId: configAssociation.projectId,
      });
    }
  }

  return findings;
}
