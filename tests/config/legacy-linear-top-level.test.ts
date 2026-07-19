import { describe, expect, it } from "vitest";
import { deriveLegacyLinearTopLevel } from "../../src/config/legacy-linear-top-level.js";
import { buildRequestedHarnessConfig } from "../../src/setup/linear-workspace-plan.js";
import { harnessConfigSchema } from "../../src/config/schema.js";

describe("legacy linear top-level derivation", () => {
  it("populates teamId only for a single unique team", () => {
    const derived = deriveLegacyLinearTopLevel({
      workspaceId: "ws-1",
      associations: [
        {
          workspaceId: "ws-1",
          teamId: "team-a",
          teamKey: "TEA",
        },
        {
          workspaceId: "ws-1",
          teamId: "team-a",
          teamKey: "TEA",
        },
      ],
    });
    expect(derived).toEqual({
      workspaceId: "ws-1",
      teamId: "team-a",
      teamKey: "TEA",
    });
  });

  it("omits teamId/teamKey when multiple teams are configured", () => {
    const derived = deriveLegacyLinearTopLevel({
      workspaceId: "ws-1",
      associations: [
        { workspaceId: "ws-1", teamId: "team-a", teamKey: "TEA" },
        { workspaceId: "ws-1", teamId: "team-b", teamKey: "TEB" },
      ],
    });
    expect(derived.workspaceId).toBe("ws-1");
    expect(derived.teamId).toBeUndefined();
    expect(derived.teamKey).toBeUndefined();
  });

  it("buildRequestedHarnessConfig never picks an arbitrary first team", () => {
    const current = harnessConfigSchema.parse({
      version: 1,
      repos: [
        {
          id: "primary",
          targetRepo: "https://github.com/acme/app",
        },
      ],
      allowedTargetRepos: ["https://github.com/acme/app"],
    });

    const next = buildRequestedHarnessConfig({
      current,
      workspaceId: "ws-1",
      requestedAssociations: [
        {
          workspaceId: "ws-1",
          teamId: "team-a",
          teamKey: "TEA",
          teamName: "Team A",
          projectId: "p1",
          projectName: "P1",
          targetRepo: "https://github.com/acme/app",
          repoConfigId: "primary",
        },
        {
          workspaceId: "ws-1",
          teamId: "team-b",
          teamKey: "TEB",
          teamName: "Team B",
          projectId: "p2",
          projectName: "P2",
          targetRepo: "https://github.com/acme/app",
          repoConfigId: "primary",
        },
      ],
    });

    expect(next.linear?.teamId).toBeUndefined();
    expect(next.linear?.teamKey).toBeUndefined();
    expect(next.repos[0]?.linearAssociations).toHaveLength(2);
  });
});
