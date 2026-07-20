import type { ResolvedLinearAssociation } from "../config/resolve-linear-workspace.js";
import { evidenceFromAssociations } from "../config/resolve-linear-workspace.js";
import type {
  LinearProjectHealth,
  LinearTeamHealth,
  LinearWorkspaceEvidence,
} from "./control-plane-types.js";
import { updateControlPlaneSetupState } from "./control-plane-setup-state.js";
import type { LinearClient } from "@linear/sdk";
import {
  createLinearSetupClient,
  getLinearProject,
  listTeamWorkflowStates,
  type LinearProjectSummary,
  type LinearWorkflowStateSummary,
} from "./linear-setup-client.js";
import {
  isWorkflowStatusCoverageComplete,
  matchWorkflowStates,
} from "./linear-setup-plan.js";
export {
  formatLinearEntityHealthLabel,
  type LinearEntityHealthLabel,
} from "./linear-entity-health-label.js";

export type VerifyLinearWorkspaceAssociationsInput = {
  cwd?: string;
  linearApiKey: string;
  workspaceId: string;
  workspaceName: string;
  associations: ResolvedLinearAssociation[];
  /** Optional injectable Linear client for tests. */
  client?: LinearClient;
  getProject?: (
    client: LinearClient,
    projectId: string,
  ) => Promise<LinearProjectSummary | null>;
  listWorkflowStates?: (
    client: LinearClient,
    teamId: string,
  ) => Promise<LinearWorkflowStateSummary[]>;
  persist?: boolean;
};

export type VerifyLinearWorkspaceAssociationsResult = {
  evidence: LinearWorkspaceEvidence;
  statusCoverageComplete: boolean;
};

function groupAssociationsByTeamId(
  associations: ResolvedLinearAssociation[],
): Map<string, ResolvedLinearAssociation[]> {
  const grouped = new Map<string, ResolvedLinearAssociation[]>();
  for (const association of associations) {
    const current = grouped.get(association.teamId) ?? [];
    current.push(association);
    grouped.set(association.teamId, current);
  }
  return grouped;
}

/**
 * Read-only Linear workspace verifier.
 * Confirms associations and required PDev workflow statuses via the existing
 * matchWorkflowStates contract, then persists durable health evidence.
 */
export async function verifyLinearWorkspaceAssociations(
  input: VerifyLinearWorkspaceAssociationsInput,
): Promise<VerifyLinearWorkspaceAssociationsResult> {
  const client =
    input.client ?? createLinearSetupClient(input.linearApiKey);
  const getProject = input.getProject ?? getLinearProject;
  const listWorkflowStates = input.listWorkflowStates ?? listTeamWorkflowStates;
  const verifiedAt = new Date().toISOString();
  const persist = input.persist !== false;

  const base = evidenceFromAssociations({
    workspaceId: input.workspaceId,
    workspaceName: input.workspaceName,
    associations: input.associations,
    appliedAt: verifiedAt,
  });

  if (input.associations.length === 0) {
    if (persist) {
      await updateControlPlaneSetupState(
        { linearWorkspace: base },
        input.cwd,
      );
    }
    return { evidence: base, statusCoverageComplete: false };
  }

  const byTeam = groupAssociationsByTeamId(input.associations);
  const workflowCoverageByTeam = new Map<string, boolean>();

  for (const [teamId, teamAssociations] of byTeam) {
    let statusesComplete = false;
    try {
      const states = await listWorkflowStates(client, teamId);
      statusesComplete = isWorkflowStatusCoverageComplete(
        matchWorkflowStates(states),
      );
    } catch {
      statusesComplete = false;
    }
    workflowCoverageByTeam.set(teamId, statusesComplete);

    const projectHealthById = new Map<string, LinearProjectHealth>();
    for (const association of teamAssociations) {
      let projectHealth: LinearProjectHealth = "needs_repair";
      try {
        const project = await getProject(client, association.projectId);
        if (!project) {
          projectHealth = "unavailable";
        } else if (!project.teamIds.includes(teamId)) {
          projectHealth = "needs_repair";
        } else if (statusesComplete) {
          projectHealth = "healthy";
        } else {
          projectHealth = "verification_pending";
        }
      } catch {
        projectHealth = "unavailable";
      }
      projectHealthById.set(association.projectId, projectHealth);
    }

    const projectHealths = [...projectHealthById.values()];
    let teamHealth: LinearTeamHealth = "verification_pending";
    if (projectHealths.some((health) => health === "unavailable")) {
      teamHealth = "unavailable";
    } else if (projectHealths.some((health) => health === "needs_repair")) {
      teamHealth = "needs_repair";
    } else if (
      statusesComplete &&
      projectHealths.every((health) => health === "healthy")
    ) {
      teamHealth = "healthy";
    } else {
      teamHealth = "verification_pending";
    }

    const teamEvidence = base.teams.find((team) => team.teamId === teamId);
    if (!teamEvidence) {
      continue;
    }
    teamEvidence.health = teamHealth;
    teamEvidence.lastVerifiedAt = verifiedAt;
    teamEvidence.projects = teamEvidence.projects.map((project) => ({
      ...project,
      health: projectHealthById.get(project.projectId) ?? "verification_pending",
      lastVerifiedAt: verifiedAt,
    }));
  }

  const statusCoverageComplete = [...byTeam.keys()].every(
    (teamId) => workflowCoverageByTeam.get(teamId) === true,
  ) &&
    base.teams.every(
      (team) =>
        team.health === "healthy" &&
        team.projects.every((project) => project.health === "healthy"),
    );

  if (persist) {
    await updateControlPlaneSetupState(
      { linearWorkspace: base },
      input.cwd,
    );
  }

  return {
    evidence: base,
    statusCoverageComplete,
  };
}
