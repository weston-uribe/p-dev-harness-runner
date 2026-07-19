import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { harnessConfigSchema } from "../config/schema.js";
import type { HarnessConfig, LinearAssociation } from "../config/types.js";
import { deriveLegacyLinearTopLevel } from "../config/legacy-linear-top-level.js";
import {
  assertSharedProjectTargetRepoConsistency,
  linearAssociationKey,
  resolveLinearAssociationsFromConfig,
  type ResolvedLinearAssociation,
} from "../config/resolve-linear-workspace.js";
import { computeLinearAssociationsFingerprint } from "./linear-workspace-migration.js";
import {
  createLinearSetupClient,
  listLinearProjects,
  listLinearTeams,
  listTeamWorkflowStates,
  type LinearProjectSummary,
  type LinearTeamSummary,
} from "./linear-setup-client.js";
import {
  matchWorkflowStates,
  type WorkflowStatusPlanEntry,
} from "./linear-setup-plan.js";
import { SETUP_PERMISSIONS } from "./permission-model.js";
import { tokenizeSecretInput } from "./secret-change-token.js";
import { resolveLocalFilePaths } from "./setup-state.js";
import { detectConfigControlPlaneDrift } from "./linear-workspace-drift.js";
import { readControlPlaneSetupState } from "./control-plane-setup-state.js";

export const LINEAR_WORKSPACE_ACTIONS = {
  preview: {
    id: "preview-linear-workspace",
    permission: SETUP_PERMISSIONS.remoteRead,
  },
  apply: {
    id: "apply-linear-workspace",
    permission: SETUP_PERMISSIONS.linearWrite,
  },
} as const;

export type LinearWorkspaceDraftAssociation = ResolvedLinearAssociation;

export type LinearWorkspaceOperation =
  | { type: "add_team"; teamId: string; teamKey: string; teamName: string }
  | { type: "repair_team_statuses"; teamId: string; teamKey: string }
  | {
      type: "add_project_association";
      teamId: string;
      projectId: string;
      targetRepo: string;
    }
  | {
      type: "repair_project_metadata";
      teamId: string;
      projectId: string;
      targetRepo: string;
    }
  | { type: "detach_project_association"; teamId: string; projectId: string }
  | { type: "detach_team"; teamId: string; teamKey: string }
  | { type: "remove_project_metadata_block"; projectId: string; projectName: string };

export type LinearWorkspacePlanInput = {
  linearApiKey: string;
  expectedCommittedFingerprint: string;
  requestedAssociations: LinearWorkspaceDraftAssociation[];
  workspaceId: string;
  workspaceName: string;
  cwd?: string;
};

export type LinearWorkspacePreview = {
  actionId: string;
  committedFingerprint: string;
  requestedFingerprint: string;
  operations: LinearWorkspaceOperation[];
  impactSummary: {
    teamsToAdd: string[];
    projectsToAdd: string[];
    teamsToRepair: string[];
    projectsToRepair: string[];
    projectsToDetach: string[];
    teamsToDetach: string[];
    metadataBlocksToRemove: string[];
    explicitNonActions: string[];
  };
  driftWarnings: ReturnType<typeof detectConfigControlPlaneDrift>;
  validationError?: string;
  fingerprint: string;
  permission: typeof SETUP_PERMISSIONS.remoteRead;
};

function associationKeys(
  associations: Array<Pick<LinearAssociation, "workspaceId" | "teamId" | "projectId">>,
): Set<string> {
  return new Set(associations.map((association) => linearAssociationKey(association)));
}

function groupByTeam(
  associations: LinearWorkspaceDraftAssociation[],
): Map<string, LinearWorkspaceDraftAssociation[]> {
  const grouped = new Map<string, LinearWorkspaceDraftAssociation[]>();
  for (const association of associations) {
    const existing = grouped.get(association.teamId) ?? [];
    existing.push(association);
    grouped.set(association.teamId, existing);
  }
  return grouped;
}

async function readHarnessConfigLocal(cwd?: string): Promise<HarnessConfig | null> {
  const paths = resolveLocalFilePaths(cwd);
  try {
    await access(paths.configLocal);
    const raw = await readFile(paths.configLocal, "utf8");
    return harnessConfigSchema.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}

function hashWorkspacePreview(input: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(input))
    .digest("hex")
    .slice(0, 16);
}

function teamStatusNeedsRepair(entries: WorkflowStatusPlanEntry[]): boolean {
  return entries.some(
    (entry) =>
      entry.action === "create" ||
      entry.action === "repair" ||
      (entry.present && !entry.categoryMatches),
  );
}

export async function previewLinearWorkspace(
  input: LinearWorkspacePlanInput,
): Promise<LinearWorkspacePreview> {
  const committedConfig = await readHarnessConfigLocal(input.cwd);
  const committedAssociations = committedConfig
    ? resolveLinearAssociationsFromConfig(committedConfig)
    : [];
  const committedFingerprint = committedConfig
    ? computeLinearAssociationsFingerprint(committedConfig)
    : "";

  const controlPlane = await readControlPlaneSetupState(input.cwd);
  const driftWarnings = committedConfig
    ? detectConfigControlPlaneDrift({ config: committedConfig, controlPlane })
    : [];

  const basePreview = {
    actionId: LINEAR_WORKSPACE_ACTIONS.preview.id,
    committedFingerprint,
    requestedFingerprint: hashWorkspacePreview(input.requestedAssociations),
    operations: [] as LinearWorkspaceOperation[],
    impactSummary: {
      teamsToAdd: [] as string[],
      projectsToAdd: [] as string[],
      teamsToRepair: [] as string[],
      projectsToRepair: [] as string[],
      projectsToDetach: [] as string[],
      teamsToDetach: [] as string[],
      metadataBlocksToRemove: [] as string[],
      explicitNonActions: [
        "Will not delete Linear teams, projects, issues, or statuses.",
        "Will not modify Linear project-team membership in v0.4.",
      ],
    },
    driftWarnings,
    permission: LINEAR_WORKSPACE_ACTIONS.preview.permission,
  };

  if (input.expectedCommittedFingerprint !== committedFingerprint) {
    return {
      ...basePreview,
      fingerprint: hashWorkspacePreview({ stale: "committed-fingerprint" }),
      validationError: "concurrent_local_edit",
    };
  }

  const consistency = assertSharedProjectTargetRepoConsistency(
    input.requestedAssociations,
  );
  if (!consistency.ok) {
    return {
      ...basePreview,
      fingerprint: hashWorkspacePreview({ invalid: consistency.code }),
      validationError: `${consistency.code}: project ${consistency.projectId} has conflicting target repos`,
    };
  }

  for (const [teamId, associations] of groupByTeam(input.requestedAssociations)) {
    if (associations.length === 0) {
      return {
        ...basePreview,
        fingerprint: hashWorkspacePreview({ invalid: "team-without-projects" }),
        validationError: `Team ${teamId} must include at least one project before apply.`,
      };
    }
  }

  if (!input.linearApiKey.trim()) {
    return {
      ...basePreview,
      fingerprint: hashWorkspacePreview({ invalid: "missing-linear-key" }),
      validationError: "LINEAR_API_KEY is required for Linear workspace preview.",
    };
  }

  const client = createLinearSetupClient(input.linearApiKey);
  const teams = await listLinearTeams(client);
  const projects = await listLinearProjects(client);
  const committedKeys = associationKeys(committedAssociations);
  const requestedKeys = associationKeys(input.requestedAssociations);
  const operations: LinearWorkspaceOperation[] = [];
  const metadataRepairProjectIds = new Set<string>();
  const metadataRemovalProjectIds = new Set<string>();

  for (const [teamId, associations] of groupByTeam(input.requestedAssociations)) {
    const sample = associations[0]!;
    const teamExists = teams.some((team) => team.id === teamId);
    const committedTeamAssociations = committedAssociations.filter(
      (association) => association.teamId === teamId,
    );
    if (!teamExists && committedTeamAssociations.length === 0) {
      operations.push({
        type: "add_team",
        teamId,
        teamKey: sample.teamKey,
        teamName: sample.teamName?.trim() || sample.teamKey,
      });
      basePreview.impactSummary.teamsToAdd.push(sample.teamKey);
    }

    const states = teamExists
      ? await listTeamWorkflowStates(client, teamId)
      : [];
    if (
      teamExists &&
      (committedTeamAssociations.length === 0 ||
        teamStatusNeedsRepair(matchWorkflowStates(states)))
    ) {
      operations.push({
        type: "repair_team_statuses",
        teamId,
        teamKey: sample.teamKey,
      });
      basePreview.impactSummary.teamsToRepair.push(sample.teamKey);
    }

    for (const association of associations) {
      const key = linearAssociationKey(association);
      if (committedKeys.has(key)) {
        continue;
      }

      const project = projects.find((item) => item.id === association.projectId);
      if (!project) {
        return {
          ...basePreview,
          fingerprint: hashWorkspacePreview({ invalid: "project-not-found" }),
          validationError: `Linear project ${association.projectName} was not found.`,
        };
      }
      if (!project.teamIds.includes(teamId)) {
        return {
          ...basePreview,
          fingerprint: hashWorkspacePreview({ invalid: "project-not-on-team" }),
          validationError: `Project ${association.projectName} is not associated with team ${association.teamKey} in Linear.`,
        };
      }

      operations.push({
        type: "add_project_association",
        teamId,
        projectId: association.projectId,
        targetRepo: association.targetRepo,
      });
      basePreview.impactSummary.projectsToAdd.push(
        `${association.teamKey}/${association.projectName}`,
      );
      if (!metadataRepairProjectIds.has(association.projectId)) {
        metadataRepairProjectIds.add(association.projectId);
        operations.push({
          type: "repair_project_metadata",
          teamId,
          projectId: association.projectId,
          targetRepo: association.targetRepo,
        });
        basePreview.impactSummary.projectsToRepair.push(association.projectName);
      }
    }
  }

  for (const association of committedAssociations) {
    const key = linearAssociationKey(association);
    if (!requestedKeys.has(key)) {
      operations.push({
        type: "detach_project_association",
        teamId: association.teamId,
        projectId: association.projectId,
      });
      basePreview.impactSummary.projectsToDetach.push(
        `${association.teamKey}/${association.projectName}`,
      );
    }
  }

  const requestedTeamIds = new Set(
    input.requestedAssociations.map((association) => association.teamId),
  );
  for (const teamId of new Set(committedAssociations.map((a) => a.teamId))) {
    if (!requestedTeamIds.has(teamId)) {
      const sample = committedAssociations.find((a) => a.teamId === teamId)!;
      operations.push({
        type: "detach_team",
        teamId,
        teamKey: sample.teamKey,
      });
      basePreview.impactSummary.teamsToDetach.push(sample.teamKey);
    }
  }

  const remainingProjectIds = new Set(
    input.requestedAssociations.map((association) => association.projectId),
  );
  for (const association of committedAssociations) {
    const key = linearAssociationKey(association);
    if (!requestedKeys.has(key) && !remainingProjectIds.has(association.projectId)) {
      if (metadataRemovalProjectIds.has(association.projectId)) {
        continue;
      }
      metadataRemovalProjectIds.add(association.projectId);
      operations.push({
        type: "remove_project_metadata_block",
        projectId: association.projectId,
        projectName: association.projectName,
      });
      basePreview.impactSummary.metadataBlocksToRemove.push(
        association.projectName,
      );
    }
  }

  const fingerprint = hashWorkspacePreview({
    actionId: LINEAR_WORKSPACE_ACTIONS.preview.id,
    committedFingerprint,
    requestedAssociations: input.requestedAssociations,
    operations,
    linearApiKeyToken: tokenizeSecretInput(input.linearApiKey),
  });

  return {
    ...basePreview,
    operations,
    fingerprint,
  };
}

export function buildRequestedHarnessConfig(input: {
  current: HarnessConfig;
  requestedAssociations: LinearWorkspaceDraftAssociation[];
  workspaceId: string;
}): HarnessConfig {
  const associationsByRepo = new Map<string, LinearAssociation[]>();
  for (const association of input.requestedAssociations) {
    const repoAssociations = associationsByRepo.get(association.repoConfigId) ?? [];
    const teamName =
      association.teamName?.trim() ||
      // Drafts may carry teamName only on control-plane evidence; never invent from key.
      undefined;
    repoAssociations.push({
      workspaceId: association.workspaceId,
      teamId: association.teamId,
      teamKey: association.teamKey,
      ...(teamName ? { teamName } : {}),
      projectId: association.projectId,
      projectName: association.projectName,
    });
    associationsByRepo.set(association.repoConfigId, repoAssociations);
  }

  const allAssociations = [...associationsByRepo.values()].flat();
  const legacyTopLevel = deriveLegacyLinearTopLevel({
    workspaceId: input.workspaceId,
    associations: allAssociations,
  });

  return harnessConfigSchema.parse({
    ...input.current,
    linear: {
      ...input.current.linear,
      workspaceId: legacyTopLevel.workspaceId,
      teamKey: legacyTopLevel.teamKey,
      teamId: legacyTopLevel.teamId,
    },
    repos: input.current.repos.map((repo) => ({
      ...repo,
      linearAssociations: associationsByRepo.get(repo.id) ?? [],
    })),
  });
}

export type { LinearTeamSummary, LinearProjectSummary };
