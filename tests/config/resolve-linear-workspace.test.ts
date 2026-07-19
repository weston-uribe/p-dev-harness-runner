import { describe, expect, it } from "vitest";
import { harnessConfigSchema } from "../../src/config/schema.js";
import {
  assertLinearAssociationConfigured,
  assertSharedProjectTargetRepoConsistency,
  detectConfigControlPlaneDrift,
  linearAssociationKey,
  resolveLinearAssociationForIssue,
  resolveLinearAssociationsFromConfig,
} from "../../src/config/resolve-linear-workspace.js";
import type { HarnessConfig } from "../../src/config/types.js";

function baseConfig(
  overrides?: Partial<HarnessConfig>,
): HarnessConfig {
  return harnessConfigSchema.parse({
    version: 1,
    repos: [
      {
        id: "primary",
        targetRepo: "https://github.com/acme/app",
        linearAssociations: [
          {
            workspaceId: "ws-1",
            teamId: "team-a",
            teamKey: "TEA",
            projectId: "proj-1",
            projectName: "Alpha",
          },
        ],
      },
    ],
    allowedTargetRepos: ["https://github.com/acme/app"],
    ...overrides,
  });
}

describe("resolve-linear-workspace", () => {
  it("resolves explicit associations from harness config", () => {
    const config = baseConfig({
      repos: [
        {
          id: "primary",
          targetRepo: "https://github.com/acme/app",
          linearAssociations: [
            {
              workspaceId: "ws-1",
              teamId: "team-a",
              teamKey: "TEA",
              projectId: "proj-1",
              projectName: "Alpha",
            },
            {
              workspaceId: "ws-1",
              teamId: "team-b",
              teamKey: "TEB",
              projectId: "proj-2",
              projectName: "Beta",
            },
          ],
        },
      ],
    });

    const associations = resolveLinearAssociationsFromConfig(config);
    expect(associations).toHaveLength(2);
    expect(associations[0]?.targetRepo).toBe("https://github.com/acme/app");
    expect(associations[1]?.teamId).toBe("team-b");
  });

  it("matches issues by exact teamId and projectId", () => {
    const config = baseConfig();
    const match = resolveLinearAssociationForIssue(config, {
      teamId: "team-a",
      projectId: "proj-1",
    });
    expect(match?.teamKey).toBe("TEA");

    const miss = resolveLinearAssociationForIssue(config, {
      teamId: "team-a",
      projectId: "proj-999",
    });
    expect(miss).toBeNull();
  });

  it("returns linear_team_project_not_configured for unconfigured pairs", () => {
    const result = assertLinearAssociationConfigured(baseConfig(), {
      teamId: "team-x",
      projectId: "proj-x",
    });
    expect(result).toEqual({ ok: false, code: "linear_team_project_not_configured" });
  });

  it("allows the same project under two teams when target repos match", () => {
    const config = baseConfig({
      repos: [
        {
          id: "primary",
          targetRepo: "https://github.com/acme/app",
          linearAssociations: [
            {
              workspaceId: "ws-1",
              teamId: "team-a",
              teamKey: "TEA",
              projectId: "shared-proj",
              projectName: "Shared",
            },
            {
              workspaceId: "ws-1",
              teamId: "team-b",
              teamKey: "TEB",
              projectId: "shared-proj",
              projectName: "Shared",
            },
          ],
        },
      ],
    });

    const associations = resolveLinearAssociationsFromConfig(config);
    const consistency = assertSharedProjectTargetRepoConsistency(associations);
    expect(consistency).toEqual({ ok: true });

    const teamAMatch = resolveLinearAssociationForIssue(config, {
      teamId: "team-a",
      projectId: "shared-proj",
    });
    const teamBMatch = resolveLinearAssociationForIssue(config, {
      teamId: "team-b",
      projectId: "shared-proj",
    });
    expect(teamAMatch?.teamId).toBe("team-a");
    expect(teamBMatch?.teamId).toBe("team-b");
  });

  it("rejects conflicting target repos for the same projectId", () => {
    const associations = [
      {
        workspaceId: "ws-1",
        teamId: "team-a",
        teamKey: "TEA",
        projectId: "shared-proj",
        projectName: "Shared",
        targetRepo: "https://github.com/acme/app-a",
        repoConfigId: "a",
      },
      {
        workspaceId: "ws-1",
        teamId: "team-b",
        teamKey: "TEB",
        projectId: "shared-proj",
        projectName: "Shared",
        targetRepo: "https://github.com/acme/app-b",
        repoConfigId: "b",
      },
    ];

    const result = assertSharedProjectTargetRepoConsistency(associations);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("linear_project_target_repo_conflict");
      expect(result.projectId).toBe("shared-proj");
      expect(result.targetRepos).toHaveLength(2);
    }
  });

  it("builds stable association keys", () => {
    expect(
      linearAssociationKey({
        workspaceId: "ws-1",
        teamId: "team-a",
        projectId: "proj-1",
      }),
    ).toBe("ws-1:team-a:proj-1");
  });

  it("falls back to teamKey + projectId when teamId is absent", () => {
    const config = baseConfig({
      repos: [
        {
          id: "primary",
          targetRepo: "https://github.com/acme/app",
          linearAssociations: [
            {
              workspaceId: "ws-1",
              teamId: "team-a",
              teamKey: "TEA",
              teamName: "Team Alpha",
              projectId: "proj-1",
              projectName: "Alpha",
            },
          ],
        },
      ],
    });

    const match = resolveLinearAssociationForIssue(config, {
      teamKey: "tea",
      projectId: "proj-1",
    });
    expect(match?.teamId).toBe("team-a");
  });

  it("falls back to full teamName + projectId and never matches name against key", () => {
    const config = baseConfig({
      repos: [
        {
          id: "primary",
          targetRepo: "https://github.com/acme/app",
          linearAssociations: [
            {
              workspaceId: "ws-1",
              teamId: "team-a",
              teamKey: "TEA",
              teamName: "fresh p-dev linear team",
              projectId: "proj-1",
              projectName: "harness",
            },
          ],
        },
      ],
    });

    expect(
      resolveLinearAssociationForIssue(config, {
        teamName: "fresh p-dev linear team",
        projectId: "proj-1",
      })?.teamId,
    ).toBe("team-a");

    expect(
      resolveLinearAssociationForIssue(config, {
        teamName: "TEA",
        projectId: "proj-1",
      }),
    ).toBeNull();
  });

  it("fails closed when project names collide across teams without team identity", () => {
    const config = baseConfig({
      repos: [
        {
          id: "primary",
          targetRepo: "https://github.com/acme/app",
          linearAssociations: [
            {
              workspaceId: "ws-1",
              teamId: "team-a",
              teamKey: "TEA",
              teamName: "Team A",
              projectId: "proj-a",
              projectName: "harness",
            },
            {
              workspaceId: "ws-1",
              teamId: "team-b",
              teamKey: "TEB",
              teamName: "Team B",
              projectId: "proj-b",
              projectName: "harness",
            },
          ],
        },
      ],
    });

    expect(
      resolveLinearAssociationForIssue(config, {
        projectId: "proj-a",
      }),
    ).toBeNull();
  });

  it("resolves teamId with a uniquely configured project", () => {
    const config = baseConfig();
    const match = resolveLinearAssociationForIssue(config, {
      teamId: "team-a",
    });
    expect(match?.projectId).toBe("proj-1");
  });

  it("detects drift between harness config and control-plane evidence", () => {
    const config = baseConfig();
    const findings = detectConfigControlPlaneDrift({
      config,
      controlPlane: {
        version: 1,
        linearWorkspace: {
          workspaceId: "ws-other",
          workspaceName: "Other",
          teams: [
            {
              teamId: "team-a",
              teamKey: "TEA",
              teamName: "Team A",
              health: "healthy",
              projects: [
                {
                  projectId: "proj-1",
                  projectName: "Alpha",
                  health: "healthy",
                },
              ],
            },
          ],
        },
      },
    });

    expect(findings.some((finding) => finding.code === "workspace_id_mismatch")).toBe(
      true,
    );
  });
});
