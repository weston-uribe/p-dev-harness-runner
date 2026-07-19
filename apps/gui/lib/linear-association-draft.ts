import type { ResolvedLinearAssociation } from "@harness/config/resolve-linear-workspace";
import {
  groupAssociationsByTeam,
  linearAssociationKey,
} from "@harness/config/resolve-linear-workspace";

export { groupAssociationsByTeam };

export function buildConfiguredAssociationKeys(
  associations: ResolvedLinearAssociation[],
): Set<string> {
  return new Set(associations.map((association) => linearAssociationKey(association)));
}

export function isAssociationAlreadyConfigured(
  configuredKeys: Set<string>,
  candidate: Pick<ResolvedLinearAssociation, "workspaceId" | "teamId" | "projectId">,
): boolean {
  return configuredKeys.has(linearAssociationKey(candidate));
}

export function removeDraftAssociation(
  associations: ResolvedLinearAssociation[],
  association: Pick<ResolvedLinearAssociation, "teamId" | "projectId">,
): ResolvedLinearAssociation[] {
  return associations.filter(
    (item) =>
      !(
        item.teamId === association.teamId &&
        item.projectId === association.projectId
      ),
  );
}

export function removeDraftTeam(
  associations: ResolvedLinearAssociation[],
  teamId: string,
): ResolvedLinearAssociation[] {
  return associations.filter((association) => association.teamId !== teamId);
}

export type AddProjectsToDraftInput = {
  draft: ResolvedLinearAssociation[];
  workspaceId: string;
  team: { id: string; key: string; name: string };
  projects: Array<{ id: string; name: string }>;
  targetRepo: string;
  repoConfigId: string;
};

export function addProjectsToDraft(
  input: AddProjectsToDraftInput,
): ResolvedLinearAssociation[] {
  if (!input.targetRepo.trim() || !input.repoConfigId.trim()) {
    return input.draft;
  }

  const configuredKeys = buildConfiguredAssociationKeys(input.draft);
  const next = [...input.draft];

  for (const project of input.projects) {
    const candidate: ResolvedLinearAssociation = {
      workspaceId: input.workspaceId,
      teamId: input.team.id,
      teamKey: input.team.key,
      teamName: input.team.name,
      projectId: project.id,
      projectName: project.name,
      targetRepo: input.targetRepo,
      repoConfigId: input.repoConfigId,
    };
    const key = linearAssociationKey(candidate);
    if (configuredKeys.has(key)) {
      continue;
    }
    next.push(candidate);
    configuredKeys.add(key);
  }

  return next;
}

export function foldResolvedAssociationIntoDraft(input: {
  draft: ResolvedLinearAssociation[];
  association: ResolvedLinearAssociation;
}): ResolvedLinearAssociation[] {
  const configuredKeys = buildConfiguredAssociationKeys(input.draft);
  const key = linearAssociationKey(input.association);
  if (configuredKeys.has(key)) {
    return input.draft;
  }
  return [...input.draft, input.association];
}
