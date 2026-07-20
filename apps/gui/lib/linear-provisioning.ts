import type { ResolvedLinearAssociation } from "@harness/config/resolve-linear-workspace";
import type { LinearSetupPlanInput } from "@harness/setup/linear-setup-plan";

export type LinearProvisionTeamMode = "existing" | "create";
export type LinearProvisionProjectMode = "existing" | "create";

export type PendingLinearCreateEntry = {
  id: string;
  workspaceId: string;
  teamMode: LinearProvisionTeamMode;
  teamId?: string;
  teamKey?: string;
  teamName?: string;
  projectMode: LinearProvisionProjectMode;
  projectId?: string;
  projectName?: string;
  targetRepo: string;
  repoConfigId: string;
};

export function describePendingCreate(entry: PendingLinearCreateEntry): string {
  const team =
    entry.teamMode === "create"
      ? `new team ${entry.teamName ?? entry.teamKey ?? "(unnamed)"}`
      : `team ${entry.teamId ?? "(unknown)"}`;
  const project =
    entry.projectMode === "create"
      ? `new project ${entry.projectName ?? "(unnamed)"}`
      : `project ${entry.projectId ?? "(unknown)"}`;
  return `${team} · ${project}`;
}

export function buildSetupPlanPayload(input: {
  teamMode: LinearProvisionTeamMode;
  teamId: string;
  teamKey: string;
  teamName: string;
  projectMode: LinearProvisionProjectMode;
  projectId: string;
  projectName: string;
  targetRepo: string;
}): Omit<LinearSetupPlanInput, "linearApiKey"> {
  return {
    team: {
      mode: input.teamMode,
      teamId: input.teamMode === "existing" ? input.teamId : undefined,
      teamKey: input.teamMode === "create" ? input.teamKey : undefined,
      teamName: input.teamMode === "create" ? input.teamName : undefined,
    },
    project: {
      mode: input.projectMode,
      projectId: input.projectMode === "existing" ? input.projectId : undefined,
      projectName:
        input.projectMode === "create" ? input.projectName : undefined,
      targetRepo: input.targetRepo || undefined,
    },
  };
}

export function buildWorkspacePlanPayload(input: {
  expectedCommittedFingerprint: string;
  workspaceId: string;
  workspaceName: string;
  requestedAssociations: ResolvedLinearAssociation[];
}) {
  return {
    expectedCommittedFingerprint: input.expectedCommittedFingerprint,
    workspaceId: input.workspaceId,
    workspaceName: input.workspaceName,
    requestedAssociations: input.requestedAssociations,
  };
}

export function isLinearProvisionFormComplete(input: {
  teamMode: LinearProvisionTeamMode;
  teamId: string;
  teamKey: string;
  teamName: string;
  projectMode: LinearProvisionProjectMode;
  projectId: string;
  projectName: string;
}): boolean {
  if (input.teamMode === "existing") {
    if (!input.teamId) return false;
    return input.projectMode === "existing"
      ? Boolean(input.projectId)
      : Boolean(input.projectName.trim());
  }
  if (!input.teamKey.trim() || !input.teamName.trim()) {
    return false;
  }
  return input.projectMode === "existing"
    ? Boolean(input.projectId)
    : Boolean(input.projectName.trim());
}

export function supportsRequestedProvisionMode(input: {
  teamMode: LinearProvisionTeamMode;
  projectMode: LinearProvisionProjectMode;
}): boolean {
  if (input.teamMode === "existing" && input.projectMode === "existing") {
    return true;
  }
  if (input.teamMode === "existing" && input.projectMode === "create") {
    return true;
  }
  if (input.teamMode === "create" && input.projectMode === "create") {
    return true;
  }
  return false;
}
