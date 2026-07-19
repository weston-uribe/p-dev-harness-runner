import { describe, expect, it } from "vitest";
import {
  addProjectsToDraft,
  buildConfiguredAssociationKeys,
  foldResolvedAssociationIntoDraft,
  groupAssociationsByTeam,
  isAssociationAlreadyConfigured,
  removeDraftAssociation,
  removeDraftTeam,
} from "../../apps/gui/lib/linear-association-draft.js";
import type { ResolvedLinearAssociation } from "@harness/config/resolve-linear-workspace";

const baseAssociation: ResolvedLinearAssociation = {
  workspaceId: "ws-1",
  teamId: "team-1",
  teamKey: "ENG",
  projectId: "project-1",
  projectName: "Alpha",
  targetRepo: "https://github.com/acme/app",
  repoConfigId: "app",
};

describe("linear association draft helpers", () => {
  it("groups associations by team", () => {
    const grouped = groupAssociationsByTeam([
      baseAssociation,
      {
        ...baseAssociation,
        projectId: "project-2",
        projectName: "Beta",
      },
      {
        ...baseAssociation,
        teamId: "team-2",
        teamKey: "OPS",
        projectId: "project-3",
        projectName: "Gamma",
      },
    ]);

    expect(grouped.size).toBe(2);
    expect(grouped.get("team-1")).toHaveLength(2);
    expect(grouped.get("team-2")).toHaveLength(1);
  });

  it("rejects duplicate associations when adding projects to draft", () => {
    const next = addProjectsToDraft({
      draft: [baseAssociation],
      workspaceId: "ws-1",
      team: { id: "team-1", key: "ENG", name: "Engineering" },
      projects: [
        { id: "project-1", name: "Alpha" },
        { id: "project-2", name: "Beta" },
      ],
      targetRepo: baseAssociation.targetRepo,
      repoConfigId: baseAssociation.repoConfigId,
    });

    expect(next).toHaveLength(2);
    expect(isAssociationAlreadyConfigured(buildConfiguredAssociationKeys(next), next[1]!)).toBe(
      true,
    );
  });

  it("removes draft associations by team and project", () => {
    const second = {
      ...baseAssociation,
      projectId: "project-2",
      projectName: "Beta",
    };
    const draft = [baseAssociation, second];
    expect(removeDraftAssociation(draft, second)).toEqual([baseAssociation]);
    expect(removeDraftTeam(draft, "team-1")).toEqual([]);
  });

  it("folds resolved associations without duplicating keys", () => {
    const folded = foldResolvedAssociationIntoDraft({
      draft: [baseAssociation],
      association: baseAssociation,
    });
    expect(folded).toHaveLength(1);

    const withNewProject = foldResolvedAssociationIntoDraft({
      draft: [baseAssociation],
      association: {
        ...baseAssociation,
        projectId: "project-2",
        projectName: "Beta",
      },
    });
    expect(withNewProject).toHaveLength(2);
  });
});
